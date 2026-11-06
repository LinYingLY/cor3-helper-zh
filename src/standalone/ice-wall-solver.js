// ice-wall-solver.js
// Auto-solver for "冰墙突破" hacking minigame on cor3.gg
// Injected into MAIN world. Controllable via window.__iceWallSolverAbort flag.
// The ICE Wall Break game shows a large composite target (9 small triangles forming
// a big triangle) and a board of ~100 triangles. The player must find where the
// target pattern appears on the board and click the anchor cell. The game has
// multiple rounds (counter shows e.g. "0/3").
//
// Algorithm: fingerprint each triangle by its inner SVG shapes. Parse the target
// preview to extract anchor fingerprint + 8 offset fingerprints. Scan the board
// grid for positions where the pattern matches. Use a MutationObserver to wait
// until exactly one candidate remains, then click it.

(function () {
	if (window.__iceWallSolverActive) {
		console.log('\u26a0\ufe0f 冰墙(ICE) 求解器已在运行，中止重复初始化。');
		return;
	}
	window.__iceWallSolverActive = true;
	window.__iceWallSolverAbort = false;
	window.__iceWallGameEnded = false;
	var gameGeneration = 0;

	// --- Utilities ------------------------------------------------------------
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	const COL_STEP = 31.5;
	const ROW_STEP = 54;

	// Post a status message visible in the popup UI
	function postStatus(msg, level) {
		window.postMessage({ type: 'COR3_ICE_WALL_STATUS', message: msg, level: level || 'info' }, '*');
	}

	// --- DOM Detection --------------------------------------------------------

	function findIceWallApp() {
		return document.querySelector(
			'[data-component-name="IceWallBreakApplication"], ' +
			'[data-sentry-component="IceWallBreakApplication"]'
		);
	}

	// --- SVG Imagery Extraction (for debug logging) --------------------------

	// Extract a compact SVG snippet from a glyph <g> element.
	// Strips data-sentry-* attributes and excess whitespace to keep logs small.
	function trimGlyphHtml(g) {
		if (!g) return '';
		var clone = g.cloneNode(true);
		// Remove data-sentry-* attributes from all elements
		var allEls = clone.querySelectorAll('*');
		for (var i = 0; i < allEls.length; i++) {
			var attrs = Array.from(allEls[i].attributes);
			for (var j = 0; j < attrs.length; j++) {
				if (attrs[j].name.startsWith('data-sentry')) allEls[i].removeAttribute(attrs[j].name);
			}
		}
		// Also strip from root
		var rootAttrs = Array.from(clone.attributes);
		for (var k = 0; k < rootAttrs.length; k++) {
			if (rootAttrs[k].name.startsWith('data-sentry')) clone.removeAttribute(rootAttrs[k].name);
		}
		return clone.outerHTML.replace(/\s{2,}/g, ' ').trim();
	}

	// Build a minimal SVG string for the target preview panel.
	function getTargetPreviewHtml() {
		var preview = document.querySelector('[data-component-name="TargetPreview"]');
		if (!preview) return null;
		var children = preview.querySelectorAll(':scope > g');
		if (children.length === 0) return null;
		var viewBox = preview.getAttribute('viewBox') || '0 0 200 120';
		var parts = ['<svg viewBox="' + viewBox + '">'];
		for (var i = 0; i < children.length; i++) parts.push(trimGlyphHtml(children[i]));
		parts.push('</svg>');
		return parts.join('');
	}

	// Build a minimal SVG string for the board region around a specific position
	// (anchor + offset cells from the target pattern).
	function getAttemptRegionHtml(cellMap, anchorCol, anchorRow, targetPattern) {
		if (!cellMap || !targetPattern) return null;
		var cells = [];
		var anchorCell = cellMap.get(anchorCol + ',' + anchorRow + ',up');
		if (anchorCell && anchorCell.el) cells.push(anchorCell.el);
		for (var i = 0; i < targetPattern.offsets.length; i++) {
			var o = targetPattern.offsets[i];
			var c = cellMap.get((anchorCol + o.dc) + ',' + (anchorRow + o.dr) + ',' + o.orient);
			if (c && c.el) cells.push(c.el);
		}
		if (cells.length === 0) return null;
		// Compute a tight viewBox around these cells
		var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
		for (var j = 0; j < cells.length; j++) {
			var t = cells[j].getAttribute('transform') || '';
			var m = t.match(/translate\(\s*([^,]+),\s*([^)]+)\)/);
			if (m) {
				var tx = parseFloat(m[1]), ty = parseFloat(m[2]);
				if (tx < minX) minX = tx;
				if (ty < minY) minY = ty;
				if (tx + 63 > maxX) maxX = tx + 63;
				if (ty + 54 > maxY) maxY = ty + 54;
			}
		}
		var vb = (minX - 2) + ' ' + (minY - 2) + ' ' + (maxX - minX + 4) + ' ' + (maxY - minY + 4);
		var parts = ['<svg viewBox="' + vb + '">'];
		for (var k = 0; k < cells.length; k++) parts.push(trimGlyphHtml(cells[k]));
		parts.push('</svg>');
		return parts.join('');
	}

	// --- Glyph Fingerprinting -------------------------------------------------

	// Build a fingerprint string from a glyph <g> element's visible SVG children.
	// Skips the bounding triangle hit-area, opacity-0 elements, and the outer
	// outline. Uses raw path "d" attributes for precision.
	function normalizeCoords(s) {
		return s.replace(/-?\d+(\.\d+)?/g, function (m) { return Math.round(parseFloat(m)).toString(); });
	}

	function getCellFingerprint(g) {
		if (g.querySelector('path[fill="#00121D"]')) return null;

		const parts = [];
		for (const el of g.children) {
			if (el.getAttribute('fill-opacity') === '0.2') continue;
			if (el.getAttribute('data-sentry-component') === 'GlyphBoundingTriangle') continue;
			if (el.style && el.style.opacity === '0') continue;

			if (el.tagName === 'path') {
				const d = el.getAttribute('d');
				if (d) parts.push('p:' + normalizeCoords(d));
			} else if (el.tagName === 'rect') {
				parts.push('r:' + normalizeCoords([
					el.getAttribute('x'),
					el.getAttribute('y'),
					el.getAttribute('width'),
					el.getAttribute('height'),
					el.getAttribute('transform') || ''
				].join(',')));
			}
		}
		return parts.length === 0 ? null : parts.join('|');
	}

	// --- Grid Coordinate Parsing ----------------------------------------------

	// Parse a glyph <g> transform into grid col/row + orientation.
	function parseCellTransform(g) {
		const t = g.getAttribute('transform') || '';
		const m = t.match(/translate\(\s*([^,]+),\s*([^)]+)\)/);
		if (!m) return null;
		return {
			col: Math.round(parseFloat(m[1]) / COL_STEP),
			row: Math.round(parseFloat(m[2]) / ROW_STEP),
			orientation: (t.includes('scale(1, -1)') || t.includes('scale(1,-1)')) ? 'down' : 'up'
		};
	}

	// --- Board Map ------------------------------------------------------------

	// Build a Map of "col,row,orient" → { el, fingerprint, col, row, orientation }
	// from the WallBoard SVG.
	function buildCellMap() {
		const map = new Map();
		const cells = document.querySelectorAll(
			'[data-component-name="WallBoard"] > g > g > g'
		);
		for (const g of cells) {
			const pos = parseCellTransform(g);
			if (!pos) continue;
			const key = pos.col + ',' + pos.row + ',' + pos.orientation;
			map.set(key, {
				el: g,
				fingerprint: getCellFingerprint(g),
				col: pos.col,
				row: pos.row,
				orientation: pos.orientation
			});
		}
		return map;
	}

	// --- Target Pattern Extraction --------------------------------------------

	var BOTTOM_LEFT_TARGET_LAYOUT = [
		'1,1,up', '2,0,up', '2,2,down', '3,1,down',
		'3,1,up', '4,0,up', '4,2,down', '5,1,down'
	].join('|');

	function getTargetLayout(cells) {
		return cells
			.map(function (c) { return c.pos.col + ',' + c.pos.row + ',' + c.pos.orientation; })
			.sort()
			.join('|');
	}

	// Extract the target pattern from the TargetPreview SVG.
	// Picks the bottommost "up" cell as anchor (highest row), breaking ties
	// by proximity to the horizontal center. For the known 9-triangle
	// bottom-left layout, the anchor is forced to (1,1,up).
	function extractTargetPattern() {
		var preview = document.querySelector('[data-component-name="TargetPreview"]');
		if (!preview) return null;
		var children = Array.from(preview.querySelectorAll(':scope > g'));
		if (children.length === 0) return null;

		var cells = [];
		for (var ci = 0; ci < children.length; ci++) {
			var pos = parseCellTransform(children[ci]);
			if (!pos) continue;
			cells.push({ pos: pos, fingerprint: getCellFingerprint(children[ci]) });
		}
		if (cells.length === 0) return null;

		var upCells = cells.filter(function (c) { return c.pos.orientation === 'up'; });
		if (upCells.length === 0) return null;

		var viewBoxAttr = (preview.getAttribute('viewBox') || '').trim();
		var viewBox = viewBoxAttr.split(/[\s,]+/).map(Number);
		var hasValidViewBox = viewBox.length === 4 &&
			viewBox.every(function (v) { return isFinite(v); }) && viewBox[2] > 0;
		var centerCol;
		if (hasValidViewBox) {
			centerCol = (viewBox[0] + viewBox[2] / 2 - COL_STEP) / COL_STEP;
		} else {
			var cols = cells.map(function (c) { return c.pos.col; });
			centerCol = (Math.min.apply(null, cols) + Math.max.apply(null, cols)) / 2;
		}

		var targetLayout = getTargetLayout(cells);
		var anchor;
		if (targetLayout === BOTTOM_LEFT_TARGET_LAYOUT) {
			anchor = upCells.find(function (c) { return c.pos.col === 1 && c.pos.row === 1; });
		}
		if (!anchor) {
			anchor = upCells[0];
			for (var i = 1; i < upCells.length; i++) {
				var cell = upCells[i];
				var isLower = cell.pos.row > anchor.pos.row;
				var isSameRowCloser = cell.pos.row === anchor.pos.row &&
					Math.abs(cell.pos.col - centerCol) < Math.abs(anchor.pos.col - centerCol);
				if (isLower || isSameRowCloser) anchor = cell;
			}
		}

		var anchorCol = anchor.pos.col;
		var anchorRow = anchor.pos.row;
		var offsets = [];
		for (var j = 0; j < cells.length; j++) {
			if (cells[j] === anchor) continue;
			var c = cells[j];
			offsets.push({
				dc: c.pos.col - anchorCol,
				dr: c.pos.row - anchorRow,
				orient: c.pos.orientation,
				fingerprint: c.fingerprint
			});
		}

		var pattern = { anchorFingerprint: anchor.fingerprint, anchorCol: anchorCol, anchorRow: anchorRow, offsets: offsets };
		return pattern;
	}

	// --- Candidate Finding ----------------------------------------------------

	// Find board positions where the target pattern matches (positive matching).
	// Uses dynamic minMatches: ceil((1+offsets.length) / 2.4)
	function findCandidates(cellMap, targetPattern, invalidPositions) {
		const { anchorFingerprint, offsets } = targetPattern;
		const totalCells = 1 + offsets.length;
		const minMatches = Math.max(2, Math.ceil(totalCells / 2.4));
		const candidates = [];

		for (const [, cell] of cellMap) {
			if (cell.orientation !== 'up') continue;
			if (invalidPositions && invalidPositions.has(cell.col + ',' + cell.row)) continue;

			let matches = 0;
			let mismatches = 0;

			// Check anchor fingerprint
			if (cell.fingerprint !== null && anchorFingerprint !== null) {
				if (cell.fingerprint === anchorFingerprint) matches++;
				else mismatches++;
			}

			// Check each offset
			for (const { dc, dr, orient, fingerprint } of offsets) {
				const offsetCell = cellMap.get(
					(cell.col + dc) + ',' + (cell.row + dr) + ',' + orient
				);
				if (!offsetCell) {
					mismatches++;
					continue;
				}
				if (offsetCell.fingerprint === null) continue;
				if (fingerprint === null) continue;

				if (offsetCell.fingerprint === fingerprint) matches++;
				else mismatches++;
			}

			if (mismatches === 0 && matches >= minMatches) {
				candidates.push({
					col: cell.col, row: cell.row, matches: matches, mismatches: mismatches,
					isCompleteMatch: matches === totalCells
				});
			}
		}

		return candidates.sort(function (a, b) { return b.matches - a.matches; });
	}

	// Elimination-based candidate finding.
	// Returns positions where NO offset has a definite mismatch or missing neighbor.
	function findPossiblePositions(cellMap, targetPattern, invalidPositions) {
		const { anchorFingerprint, offsets } = targetPattern;
		const possible = [];

		for (const [, cell] of cellMap) {
			if (cell.orientation !== 'up') continue;
			if (invalidPositions && invalidPositions.has(cell.col + ',' + cell.row)) continue;

			let impossible = false;

			// Check anchor
			if (cell.fingerprint !== null && anchorFingerprint !== null) {
				if (cell.fingerprint !== anchorFingerprint) impossible = true;
			}

			if (!impossible) {
				for (const { dc, dr, orient, fingerprint } of offsets) {
					const offsetCell = cellMap.get(
						(cell.col + dc) + ',' + (cell.row + dr) + ',' + orient
					);
					if (!offsetCell) {
						impossible = true;
						break;
					}
					if (offsetCell.fingerprint === null || fingerprint === null) continue;
					if (offsetCell.fingerprint !== fingerprint) {
						impossible = true;
						break;
					}
				}
			}

			if (!impossible) possible.push({ col: cell.col, row: cell.row });
		}

		return possible;
	}

	// --- Click Simulation -----------------------------------------------------

	function clickAnchor(anchorCell) {
		const target = anchorCell.el.querySelector(
			'[data-sentry-component="GlyphBoundingTriangle"]'
		) || anchorCell.el;
		target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
	}

	// --- Round Tracking -------------------------------------------------------

	function getRoundSignature() {
		const counter = document.querySelector('[data-sentry-element="SidebarCounterStyled"] span');
		const preview = document.querySelector('[data-component-name="TargetPreview"]');
		return (counter ? counter.textContent || '' : '') + '||' +
			(preview ? preview.innerHTML.slice(0, 300) : '');
	}

	function getRoundCounts() {
		const counter = document.querySelector('[data-sentry-element="SidebarCounterStyled"]');
		if (!counter) return null;
		const spans = counter.querySelectorAll('span');
		if (spans.length < 2) return null;
		const completed = parseInt(spans[0].textContent || '', 10);
		const totalMatch = (spans[1].textContent || '').match(/\d+/);
		const total = totalMatch ? parseInt(totalMatch[0], 10) : NaN;
		if (isNaN(completed) || isNaN(total)) return null;
		return { completed: completed, total: total };
	}

	// Wait for next round: completed counter increments AND new target pattern exists
	async function waitForNextRound(completedBefore, timeout) {
		timeout = timeout || 10000;
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (window.__iceWallSolverAbort || window.__iceWallGameEnded) return false;
			if (!findIceWallApp()) return false;
			const counts = getRoundCounts();
			// Game finished — counter reached its total
			if (counts && isFinite(counts.total) && counts.completed >= counts.total) return false;
			if (counts && counts.completed > completedBefore && extractTargetPattern()) return true;
			await sleep(150);
		}
		return false;
	}

	// --- Wait for unique match using MutationObserver -------------------------

	// Watches the board for mutations (glyph reveals) and resolves when exactly
	// one candidate remains. Resolves with the full cellMap, or null if the
	// game closes / board disappears.
	function waitForUniqueCandidate(targetPattern, invalidPositions) {
		return new Promise(function (resolve) {
			var settled = false;
			var debounceTimer = null;
			var startTime = Date.now();
			var TIMEOUT_MS = 45000;
			var lastRevealed = -1;
			var lastDiagTime = 0;
			var observedBoard = null;
			var observer = null;

			function cleanup() {
				settled = true;
				if (observer) observer.disconnect();
				clearInterval(pollInterval);
				document.removeEventListener('visibilitychange', onVisibilityChange);
			}

			function reattachObserver() {
				var board = document.querySelector('[data-component-name="WallBoard"]');
				if (!board || board === observedBoard) return;
				if (observer) observer.disconnect();
				observer = new MutationObserver(scheduledEval);
				observer.observe(board, { subtree: true, childList: true, attributes: true, characterData: true });
				observedBoard = board;
			}

			function tryEval() {
				if (settled) return;
				if (window.__iceWallSolverAbort || window.__iceWallGameEnded) {
					cleanup();
					return resolve(null);
				}
				if (!document.querySelector('[data-component-name="WallBoard"]')) {
					cleanup();
					return resolve(null);
				}
				if (Date.now() - startTime > TIMEOUT_MS) {
					var finalMap = buildCellMap();
					var finalRevealed = 0;
					for (var _fr of finalMap.values()) { if (_fr.fingerprint !== null) finalRevealed++; }
					var finalPossible = findPossiblePositions(finalMap, targetPattern, invalidPositions);
					if (finalPossible.length > 0 && finalPossible.length <= 5) {
						console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f waitForUniqueCandidate 超时（' + finalRevealed + '/' + finalMap.size + ' 已揭示) \u2014 ' + finalPossible.length + ' 个可能位置，尝试最佳猜测');
						cleanup();
						return resolve(finalMap);
					}
					console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f waitForUniqueCandidate 超时，已等待 ' + (TIMEOUT_MS / 1000) + 's (' + finalRevealed + '/' + finalMap.size + ' 已揭示)');
					cleanup();
					return resolve(null);
				}
				reattachObserver();
				var cellMap = buildCellMap();
				var candidates = findCandidates(cellMap, targetPattern, invalidPositions);

				var revealed = 0;
				for (var _e of cellMap.values()) { if (_e.fingerprint !== null) revealed++; }
				if (revealed !== lastRevealed) {
					lastRevealed = revealed;
				}

				if (candidates.length === 0) {
					var possible = findPossiblePositions(cellMap, targetPattern, invalidPositions);
					var now = Date.now();
					if (now - startTime > 5000 && now - lastDiagTime > 5000) {
						lastDiagTime = now;
						console.log('\uD83D\uDD13 [COR3 助手] 诊断：0 个候选，' + possible.length + ' 种可能， ' + revealed + '/' + cellMap.size + ' 已揭示，锚点指纹： ' + (targetPattern.anchorFingerprint || 'null').substring(0, 40));
					}
					if (possible.length === 1) {
						cleanup();
						resolve(cellMap);
					} else if (possible.length === 0) {
						console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 无可用位置——放弃');
						cleanup();
						resolve(null);
					}
					return;
				}

				if (candidates.some(function (c) { return c.isCompleteMatch; })) {
					cleanup();
					resolve(cellMap);
					return;
				}

				if (candidates.length === 1) {
					cleanup();
					resolve(cellMap);
					return;
				}

				console.log(
					'%c\uD83D\uDD13 [COR3 Helper] ' + candidates.length +
					' 个候选(最佳：' + candidates[0].matches + ' 项匹配， ' + revealed + ' 已揭示）— 等待更多揭示...',
					'color: #76C1D1'
				);
			}

			function scheduledEval() {
				if (settled) return;
				clearTimeout(debounceTimer);
				debounceTimer = setTimeout(tryEval, 60);
			}

			function onVisibilityChange() {
				if (document.visibilityState === 'visible') {
					tryEval();
				}
			}

			var board = document.querySelector('[data-component-name="WallBoard"]');
			if (!board) { resolve(null); return; }

			observer = new MutationObserver(scheduledEval);
			observer.observe(board, { subtree: true, childList: true, attributes: true, characterData: true });
			observedBoard = board;

			document.addEventListener('visibilitychange', onVisibilityChange);

			var pollInterval = setInterval(function () {
				if (settled) { clearInterval(pollInterval); return; }
				if (window.__iceWallSolverAbort || window.__iceWallGameEnded) {
					cleanup();
					resolve(null);
					return;
				}
				if (!document.querySelector('[data-component-name="WallBoard"]')) {
					cleanup();
					resolve(null);
					return;
				}
				if (Date.now() - startTime > TIMEOUT_MS) {
					var tMap = buildCellMap();
					var tRevealed = 0;
					for (var _tr of tMap.values()) { if (_tr.fingerprint !== null) tRevealed++; }
					var tPossible = findPossiblePositions(tMap, targetPattern, invalidPositions);
					if (tPossible.length > 0 && tPossible.length <= 5) {
						console.log('\uD83D\uDD13 [COR3 Helper] \u26a0\ufe0f waitForUniqueCandidate 轮询超时 (' + tRevealed + '/' + tMap.size + ' 已揭示) \u2014 ' + tPossible.length + ' 个可能位置，尝试最佳猜测');
						cleanup();
						resolve(tMap);
						return;
					}
					console.log('\uD83D\uDD13 [COR3 Helper] \u26a0\ufe0f waitForUniqueCandidate 轮询超时 (' + tRevealed + '/' + tMap.size + ' 已揭示)');
					cleanup();
					resolve(null);
					return;
				}
				reattachObserver();
				tryEval();
			}, 150);

			scheduledEval();
		});
	}

	// --- Wait for advance (click success) ------------------------------------

	async function waitForAdvance(prevSignature, timeout) {
		timeout = timeout || 1500;
		const start = Date.now();
		while (Date.now() - start < timeout) {
			if (window.__iceWallGameEnded) return true;
			if (!findIceWallApp()) return true;
			if (getRoundSignature() !== prevSignature) return true;
			await sleep(100);
		}
		return false;
	}

	// --- Solve one round (with false-positive retry loop) --------------------

	async function runIceWallRound(targetPattern) {
		const invalidPositions = new Set();
		const MAX_FALSE_POSITIVES = 8;
		let falsePositiveCount = 0;

		while (true) {
			if (window.__iceWallSolverAbort || window.__iceWallGameEnded) return;
			if (!findIceWallApp()) return;

			var cellMap = await waitForUniqueCandidate(targetPattern, invalidPositions);
			if (!cellMap) return; // game closed or ended

			var candidates = findCandidates(cellMap, targetPattern, invalidPositions);
			var best = null;

			if (candidates.length > 0) {
				best = candidates.find(function (c) { return c.isCompleteMatch; }) || candidates[0];
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] \u2705 匹配于 col=' + best.col +
					' row=' + best.row + ' (' + best.matches + ' 项匹配' +
					(best.isCompleteMatch ? '，完成' : '') + ')',
					'color: #8fb24e; font-weight: bold'
				);
				postStatus('正在点击匹配 (' + best.matches + ' 条命中)', 'info');
			} else {
				var possible = findPossiblePositions(cellMap, targetPattern, invalidPositions);
				if (possible.length === 0) {
					console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 没有候选或可用位置了');
					return;
				}
				best = possible[0];
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] \u2705 已排除至 col=' + best.col +
					' row=' + best.row + ' (无其他可用位置)',
					'color: #a0d070; font-weight: bold'
				);
				postStatus('正在点击已消除的匹配', 'info');
			}

			var anchorCell = cellMap.get(best.col + ',' + best.row + ',up');
			var prevSig = getRoundSignature();

			if (anchorCell) {
				clickAnchor(anchorCell);
			} else {
				console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 锁定后未找到锚点格。');
			}

			var advanced = await waitForAdvance(prevSig);
			if (advanced) return; // success — round advanced

			falsePositiveCount++;
			var failedParts = [];
			var failAnchor = cellMap.get(best.col + ',' + best.row + ',up');
			failedParts.push('anchor(' + best.col + ',' + best.row + '):' + (failAnchor && failAnchor.fingerprint ? failAnchor.fingerprint.substring(0, 40) : 'null'));
			for (var fi = 0; fi < targetPattern.offsets.length; fi++) {
				var fo = targetPattern.offsets[fi];
				var fCell = cellMap.get((best.col + fo.dc) + ',' + (best.row + fo.dr) + ',' + fo.orient);
				var match = fCell && fCell.fingerprint && fo.fingerprint && fCell.fingerprint === fo.fingerprint;
				failedParts.push('off(' + fo.dc + ',' + fo.dr + ',' + fo.orient + '):' + (fCell && fCell.fingerprint ? fCell.fingerprint.substring(0, 40) : 'null') + (match ? ' ✓' : ' ✗'));
			}
			console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 序列失败，col=' + best.col + ' row=' + best.row + ':', failedParts.join(' | '));
			var attemptHtml = getAttemptRegionHtml(cellMap, best.col, best.row, targetPattern);
			if (attemptHtml) console.log('\uD83D\uDD13 [COR3 助手] 尝试失败 SVG（col=' + best.col + ' row=' + best.row + '):\n' + attemptHtml);
			console.log(
				'\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 误判，col=' + best.col +
				' row=' + best.row + ' (' + falsePositiveCount + '/' + MAX_FALSE_POSITIVES + '）\u2014 标记为无效并重试...'
			);
			postStatus('误报 (' + falsePositiveCount + '/' + MAX_FALSE_POSITIVES + '), 正在重试...', 'warn');
			invalidPositions.add(best.col + ',' + best.row);

			if (falsePositiveCount >= MAX_FALSE_POSITIVES) {
				console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 误判次数已达上限——放弃本轮');
				postStatus('已达最大重试次数，跳过本轮', 'error');
				return;
			}

			var freshTarget = extractTargetPattern();
			if (freshTarget) {
				targetPattern = freshTarget;
			}

			var remainingMap = buildCellMap();
			var remainingPositions = findPossiblePositions(remainingMap, targetPattern, invalidPositions);
			console.log('\uD83D\uDD13 [COR3 助手] 正在重试，使用 ' + remainingPositions.length + ' 个剩余可能位置');

			await sleep(200);
		}
	}

	// --- Main game solver (handles all rounds) --------------------------------

	async function runIceWallSolver() {
		console.log(
			'%c\uD83D\uDD13 [COR3 助手] 启动冰墙(ICE) 求解器...',
			'color: #4ec9f3; font-weight: bold'
		);
		postStatus('冰墙求解器已启动', 'info');

		var totalRounds = null;
		var counts = getRoundCounts();
		if (counts && isFinite(counts.total)) totalRounds = counts.total;
		var roundsCompleted = 0;

		function refreshTotal() {
			var t = getRoundCounts();
			if (t && isFinite(t.total)) totalRounds = t.total;
		}
		function totalLabel() {
			return totalRounds !== null ? '/' + totalRounds : '';
		}

		while (true) {
			if (window.__iceWallSolverAbort || window.__iceWallGameEnded) return;
			if (!findIceWallApp()) break;
			refreshTotal();
			if (totalRounds !== null && roundsCompleted >= totalRounds) break;

			var targetPattern = extractTargetPattern();
			if (!targetPattern) {
				await sleep(100);
				continue;
			}

			// Debug: log target sequence fingerprints + SVG imagery (once per round)
			var targetSeqParts = ['anchor(' + targetPattern.anchorCol + ',' + targetPattern.anchorRow + '):' + (targetPattern.anchorFingerprint ? targetPattern.anchorFingerprint.substring(0, 40) : 'null')];
			for (var ti = 0; ti < targetPattern.offsets.length; ti++) {
				var o = targetPattern.offsets[ti];
				targetSeqParts.push('off(' + o.dc + ',' + o.dr + ',' + o.orient + '):' + (o.fingerprint ? o.fingerprint.substring(0, 40) : 'null'));
			}
			console.log('\uD83D\uDD13 [COR3 助手] 目标序列：', targetSeqParts.join(' | '));
			var targetHtml = getTargetPreviewHtml();
			if (targetHtml) console.log('\uD83D\uDD13 [COR3 助手] 目标 SVG：\n' + targetHtml);

			var roundLabel = '第 ' + (roundsCompleted + 1) + totalLabel();
			var hintCount = 1 + targetPattern.offsets.length;
			console.log(
				'%c\uD83D\uDD13 [COR3 Helper] ' + roundLabel +
				' \u2014 正在搜寻(' + hintCount + ' 条提示)...',
				'color: #76C1D1; font-weight: bold'
			);
			postStatus(roundLabel + '：扫描中（' + hintCount + ' 条提示)', 'info');

			var completedBefore = (getRoundCounts() || {}).completed || roundsCompleted;
			await runIceWallRound(targetPattern);
			roundsCompleted++;

			if (window.__iceWallSolverAbort || window.__iceWallGameEnded) return;

			refreshTotal();
			if (totalRounds !== null && roundsCompleted >= totalRounds) break;

			console.log(
				'%c\uD83D\uDD13 [COR3 助手] 轮次 ' + roundsCompleted + totalLabel() +
				' 已完成。等待下一轮...',
				'color: #888; font-style: italic'
			);
			postStatus('第 ' + roundsCompleted + totalLabel() + '：完成', 'success');

			if (!(await waitForNextRound(completedBefore, 10000))) {
				console.log('\uD83D\uDD13 [COR3 助手] \u26a0\ufe0f 等待下一轮超时——停止');
				break;
			}
		}

		var finishMsg = '已完成 (' + roundsCompleted + totalLabel() + ' 轮已完成)';
		console.log(
			'%c\uD83D\uDD13 [COR3 Helper] ' + finishMsg,
			'color: #8fb24e; font-weight: bold'
		);
		postStatus(finishMsg, 'success');
	}

	// --- Watcher & External API -----------------------------------------------

	let pendingMinigameData = null;
	const solverListeners = [];

	// External API: await window.awaitIceWallSolver() to wait for solver to finish
	window.awaitIceWallSolver = function () {
		return new Promise(function (resolve) {
			solverListeners.push(resolve);
		});
	};

	window.addEventListener('message', function (event) {
		if (event.data && event.data.type === 'COR3_ICE_WALL_MINIGAME_START') {
			// Signal current solver to stop — a new game session is starting
			window.__iceWallGameEnded = true;
			gameGeneration++;
			pendingMinigameData = event.data.data;
			var sp = pendingMinigameData.meta?.staticParams;
			var logParts = ['难度:', sp?.difficulty, '最大尝试次数：', sp?.maxAttempts];
			if (sp?.timerDurationMs != null) logParts.push('计时器：', sp.timerDurationMs + 'ms');
			console.log(
				'%c\uD83D\uDD13 [COR3 助手] 冰墙(ICE) 小游戏已开始！',
				'color: #4ec9f3; font-weight: bold',
				...logParts
			);
		} else if (event.data && event.data.type === 'COR3_ICE_WALL_GAME_ENDED') {
			window.__iceWallGameEnded = true;
		}
	});

	async function watchForIceWall() {
		console.log(
			'%c\uD83D\uDD13 [COR3 助手] 冰墙(ICE) 求解器正在等待小游戏...',
			'color: #888; font-style: italic'
		);

		while (!window.__iceWallSolverAbort) {
			const app = findIceWallApp();
			if (app) {
				// Reset game-ended flag for this new game session
				window.__iceWallGameEnded = false;
				var currentGen = gameGeneration;
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] 在 DOM 中检测到冰墙(ICE) 小游戏！',
					'color: #4ec9f3; font-weight: bold'
				);

				await runIceWallSolver();

				if (window.__iceWallSolverAbort) break;

				// Wait for the game app to be removed from DOM OR a new game to start
				if (findIceWallApp() && !window.__iceWallGameEnded) {
					console.log(
						'%c\u23f3 [COR3 助手] 等待冰墙(ICE) 小游戏关闭...',
						'color: #888; font-style: italic'
					);
				}
				while (!window.__iceWallSolverAbort && !window.__iceWallGameEnded && findIceWallApp()) {
					// Also break out if a new game generation started
					if (gameGeneration !== currentGen) break;
					await sleep(100);
				}

				// Notify any external code waiting for solver completion
				while (solverListeners.length) {
					var fn = solverListeners.shift();
					try { fn(); } catch (e) { console.log('[COR3 Helper] 求解器监听器出错：', e); }
				}

				if (!window.__iceWallSolverAbort) {
					console.log(
						'%c\uD83D\uDD13 [COR3 助手] 冰墙(ICE) 小游戏已关闭，等待下一个...',
						'color: #888; font-style: italic'
					);
				}

				pendingMinigameData = null;
			}

			await sleep(250);
		}

		// Cleanup when aborted
		window.__iceWallSolverActive = false;
		window.__iceWallSolverAbort = false;
		console.log(
			'%c\ud83d\udED1 [COR3 助手] 冰墙(ICE) 求解器已停止。',
			'color: #ff5555; font-weight: bold'
		);
	}

	watchForIceWall();
})();
