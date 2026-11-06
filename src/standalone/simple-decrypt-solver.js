// simple-decrypt-solver.js
// Auto-solver for "简易解密" hacking minigame on cor3.gg
// Injected into MAIN world. Controllable via window.__simpleDecryptSolverAbort flag.
// The game shows a "解密" button, a segmented progress bar, and a percentage label.
// Strategy: click the Decrypt button, then poll until the progress reaches 100% or
// the SimpleDecryptApplication element disappears (game completed).

(function () {
	if (window.__simpleDecryptSolverActive) {
		console.log('\u26a0\ufe0f 简易解密求解器已在运行，中止重复初始化。');
		return;
	}
	window.__simpleDecryptSolverActive = true;
	window.__simpleDecryptSolverAbort = false;

	// --- Utilities ------------------------------------------------------------
	const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

	// Post a status message visible in the popup UI
	function postStatus(msg, level) {
		window.postMessage({ type: 'COR3_SIMPLE_DECRYPT_STATUS', message: msg, level: level || 'info' }, '*');
	}

	// --- DOM Detection --------------------------------------------------------

	function findSimpleDecryptApp() {
		return document.querySelector(
			'[data-component-name="SimpleDecryptApplication"], ' +
			'[data-sentry-component="SimpleDecryptApplication"]'
		);
	}

	function findDecryptButton() {
		return document.querySelector(
			'[data-sentry-element="DecryptButtonStyled"], ' +
			'button.go1966296074'
		);
	}

	// Read the progress percentage from the footer label (e.g. "解码信号")
	function getProgressPercent() {
		const label = document.querySelector(
			'[data-sentry-element="FooterCenterLabelStyled"]'
		);
		if (!label) return null;
		const text = label.textContent || '';
		const match = text.match(/(\d+)\s*%/);
		return match ? parseInt(match[1], 10) : null;
	}

	// --- Solve one instance of the Simple Decrypt game ------------------------

	async function solveSimpleDecrypt() {
		console.log(
			'%c\uD83D\uDD13 [COR3 助手] 启动简易解密求解器...',
			'color: #4ec9f3; font-weight: bold'
		);
		postStatus('简易解密求解器已启动', 'info');

		// Wait a moment for UI to fully render
		await sleep(500);
		if (window.__simpleDecryptSolverAbort) return;

		// Find and click the Decrypt button
		const btn = findDecryptButton();
		if (!btn) {
			console.log('\uD83D\uDD13 [COR3 助手] 未找到解密按钮');
			postStatus('解密进度 45%', 'error');
			return;
		}

		btn.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
		console.log(
			'%c\uD83D\uDD13 [COR3 助手] 已点击解密按钮——等待进度...',
			'color: #76C1D1'
		);
		postStatus('已点击解密 — 等待进度...', 'info');

		// Poll until progress reaches 100% or the app disappears
		const startTime = Date.now();
		const MAX_WAIT = 120000; // 2 minute max wait
		let lastPercent = -1;

		while (Date.now() - startTime < MAX_WAIT) {
			if (window.__simpleDecryptSolverAbort) return;

			// Check if game closed (decryption completed)
			if (!findSimpleDecryptApp()) {
				const elapsed = Math.round((Date.now() - startTime) / 1000);
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] 简易解密完成！（' + elapsed + 's)',
					'color: #8fb24e; font-weight: bold'
				);
				postStatus('正在解密... ' + elapsed + 's)', 'success');
				return;
			}

			// Log progress changes
			const pct = getProgressPercent();
			if (pct !== null && pct !== lastPercent) {
				lastPercent = pct;
				if (pct % 25 === 0 || pct >= 90) {
					console.log(
						'%c\uD83D\uDD13 [COR3 助手] 解密进度：' + pct + '%',
						'color: #76C1D1'
					);
					postStatus('解密步骤' + pct + '%', 'info');
				}
			}

			if (pct !== null && pct >= 100) {
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] 解密进度已达 100%！',
					'color: #8fb24e; font-weight: bold'
				);
				postStatus('解密完成! (', 'success');
				// Wait a moment for the game to close itself
				await sleep(2000);
				return;
			}

			await sleep(500);
		}

		console.log('\uD83D\uDD13 [COR3 助手] 简易解密超过 2 分钟未完成');
		postStatus('解密进度达到 100%', 'error');
	}

	// --- Watcher (continuously watches for SimpleDecrypt app to appear) --------

	async function watchForSimpleDecrypt() {
		console.log(
			'%c\uD83D\uDD13 [COR3 助手] 简易解密求解器正在等待小游戏...',
			'color: #888; font-style: italic'
		);

		while (!window.__simpleDecryptSolverAbort) {
			await sleep(500);

			const app = findSimpleDecryptApp();
			if (app) {
				console.log(
					'%c\uD83D\uDD13 [COR3 助手] 在 DOM 中检测到简易解密小游戏！',
					'color: #4ec9f3; font-weight: bold'
				);

				// Wait for game to fully initialize
				await sleep(1000);

				if (window.__simpleDecryptSolverAbort) break;

				await solveSimpleDecrypt();

				if (window.__simpleDecryptSolverAbort) break;

				// Wait for the game app to be removed from DOM
				console.log(
					'%c\u23f3 [COR3 助手] 等待简易解密小游戏关闭...',
					'color: #888; font-style: italic'
				);
				while (!window.__simpleDecryptSolverAbort && findSimpleDecryptApp()) {
					await sleep(100);
				}

				if (!window.__simpleDecryptSolverAbort) {
					console.log(
						'%c\uD83D\uDD13 [COR3 助手] 简易解密小游戏已关闭，等待下一个...',
						'color: #888; font-style: italic'
					);
				}
			}
		}

		// Cleanup when aborted
		window.__simpleDecryptSolverActive = false;
		window.__simpleDecryptSolverAbort = false;
		console.log(
			'%c\ud83d\udED1 [COR3 助手] 简易解密求解器已停止。',
			'color: #ff5555; font-weight: bold'
		);
	}

	// Listen for start/stop messages from content.js
	window.addEventListener('message', function (event) {
		if (event.source !== window) return;
		if (event.data && event.data.type === 'COR3_STOP_SIMPLE_DECRYPT_SOLVER') {
			window.__simpleDecryptSolverAbort = true;
		}
		if (event.data && event.data.type === 'COR3_START_SIMPLE_DECRYPT_SOLVER') {
			if (!window.__simpleDecryptSolverActive) {
				window.__simpleDecryptSolverActive = true;
				window.__simpleDecryptSolverAbort = false;
				watchForSimpleDecrypt();
			}
		}
	});

	watchForSimpleDecrypt();
})();
