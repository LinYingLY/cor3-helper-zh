// --- Pop Out / Side Panel ---
import { getCor3Tab } from './utils.js';

const statusDiv = document.getElementById('status');
const popOutBtn = document.getElementById('popOutBtn');
const sidePanelBtn = document.getElementById('sidePanelBtn');

// Detect if we're running inside a popout window (via ?mode=popout query param)
(function detectMode() {
    const params = new URLSearchParams(window.location.search);
    const isPopout = params.get('mode') === 'popout';
    const isSidePanel = params.get('mode') === 'sidepanel';
    if (!isPopout && !isSidePanel) return;
    document.body.classList.add(isPopout ? 'mode-popout' : 'mode-sidepanel');

    // --- Build popout multi-column grid dynamically ---
    const mainView = document.getElementById('mainView');
    if (!mainView) return;

    function makeCard(elements) {
        const card = document.createElement('div');
        card.className = 'popout-card';
        for (const el of elements) card.appendChild(el);
        return card;
    }

    const grid = document.createElement('div');
    grid.id = 'popoutGrid';

    const headerRow = mainView.querySelector('.header-row');
    const insertRef = headerRow ? headerRow.nextSibling : mainView.firstChild;
    const wrappedEls = new Set();

    function addCard(elements) {
        if (!elements || elements.length === 0) return;
        const filtered = elements.filter(Boolean);
        if (filtered.length === 0) return;
        const card = makeCard(filtered);
        grid.appendChild(card);
        for (const el of filtered) wrappedEls.add(el);
    }

    const helperDiv = mainView.querySelector('#helperModeToggle')?.closest('div[style*="justify-content"]');
    const pinned = document.getElementById('pinnedTimersSection');
    addCard([helperDiv, pinned].filter(Boolean));

    addCard([mainView.querySelector('.toggles-section')].filter(Boolean));

    addCard([document.getElementById('autoJobSolverSection')].filter(Boolean));

    addCard([document.getElementById('autoValuableSellerSection')].filter(Boolean));

    const allSections = mainView.querySelectorAll(':scope > .section');

    for (const s of allSections) {
        if (s.querySelector('#refreshDailyBtn') && !s.querySelector('#marketContainer')) {
            addCard([s]);
            break;
        }
    }

    let marketsSection = null;
    for (const s of allSections) {
        if (s.querySelector('#marketContainer')) { marketsSection = s; break; }
    }
    if (marketsSection) {
        wrappedEls.add(marketsSection);
        const mTitle = marketsSection.querySelector(':scope > .section-title');
        const subSections = marketsSection.querySelectorAll(':scope > .sub-section');
        const overlays = [
            marketsSection.querySelector('#marketInfoOverlay'),
            marketsSection.querySelector('#marketInfoPopup')
        ].filter(Boolean);

        if (subSections.length > 0) {
            const firstGroup = [mTitle, subSections[0]].filter(Boolean);
            if (subSections.length === 1) firstGroup.push(...overlays);
            addCard(firstGroup);
            for (let mi = 1; mi < subSections.length; mi++) {
                const group = [subSections[mi]];
                if (mi === subSections.length - 1) group.push(...overlays);
                addCard(group);
            }
        } else {
            addCard([marketsSection]);
        }
    }

    let expeditionsSection = null;
    for (const s of allSections) {
        if (s.querySelector('#expeditionInfoContainer') || s.querySelector('#activeExpeditionSection')) {
            expeditionsSection = s;
            break;
        }
    }
    if (expeditionsSection) {
        wrappedEls.add(expeditionsSection);
        const expChildren = Array.from(expeditionsSection.children);
        const splitPoints = [
            { id: 'personalDroneSectionToggle', label: '个人无人机' },
            { id: 'decisionsSectionToggle', label: '判定:' },
            { id: 'inventorySectionToggle', label: '物品栏' },
            { id: 'mercenariesSectionToggle', label: '佣兵' },
            { id: 'archivedExpSectionToggle', label: '已归档' }
        ];
        const splitIndices = [];
        for (const sp of splitPoints) {
            const idx = expChildren.findIndex(el =>
                el.nodeType === 1 && (el.id === sp.id || el.querySelector('#' + sp.id))
            );
            if (idx >= 0) splitIndices.push(idx);
        }
        splitIndices.sort((a, b) => a - b);

        if (splitIndices.length > 0) {
            addCard(expChildren.slice(0, splitIndices[0]));
            for (let si = 0; si < splitIndices.length; si++) {
                const start = splitIndices[si];
                const end = si + 1 < splitIndices.length ? splitIndices[si + 1] : expChildren.length;
                addCard(expChildren.slice(start, end));
            }
        } else {
            addCard([expeditionsSection]);
        }
    }

    let loadoutSection = null;
    for (const s of allSections) {
        if (s.querySelector('#refreshLoadoutBtn') || s.querySelector('#loadoutHwContainer')) {
            loadoutSection = s;
            break;
        }
    }
    if (loadoutSection) {
        wrappedEls.add(loadoutSection);
        const ldChildren = Array.from(loadoutSection.children);
        const swToggleIdx = ldChildren.findIndex(el => el.querySelector('#loadoutSwToggle') || el.id === 'loadoutSwToggle');
        const ovToggleIdx = ldChildren.findIndex(el => el.querySelector('#loadoutOverviewToggle') || el.id === 'loadoutOverviewToggle');
        const ldSplits = [swToggleIdx, ovToggleIdx].filter(i => i >= 0).sort((a, b) => a - b);

        if (ldSplits.length > 0) {
            addCard(ldChildren.slice(0, ldSplits[0]));
            for (let li = 0; li < ldSplits.length; li++) {
                const start = ldSplits[li];
                const end = li + 1 < ldSplits.length ? ldSplits[li + 1] : ldChildren.length;
                addCard(ldChildren.slice(start, end));
            }
        } else {
            addCard([loadoutSection]);
        }
    }

    for (const s of allSections) {
        if (wrappedEls.has(s)) continue;
        if (s.querySelector('.alarm-section-title') || s.querySelector('#alarmList')) {
            addCard([s]);
        }
    }

    const versionEls = [];
    const vi = document.getElementById('versionInfoSection');
    if (vi) { const p = vi.closest('div[style*="border-top"]'); if (p) versionEls.push(p); }
    const cb = document.getElementById('checkUpdateBtn');
    if (cb) { const p = cb.closest('div[style*="text-align:center"]'); if (p) versionEls.push(p); }
    const st = document.getElementById('status');
    if (st) versionEls.push(st);
    addCard(versionEls);

    if (marketsSection) marketsSection.remove();
    if (expeditionsSection) expeditionsSection.remove();
    if (loadoutSection) loadoutSection.remove();

    const remaining = Array.from(mainView.children).filter(
        el => !wrappedEls.has(el) && el !== headerRow && !el.classList.contains('theme-dropdown') && el !== grid
    );
    for (const el of remaining) {
        if (el.nodeType !== 1) continue;
        if (el.id === 'popoutGrid') continue;
        const card = document.createElement('div');
        card.className = 'popout-card';
        card.appendChild(el);
        grid.appendChild(card);
    }

    mainView.insertBefore(grid, insertRef);
})();

if (popOutBtn) {
    popOutBtn.addEventListener('click', () => {
        chrome.windows.create({
            url: chrome.runtime.getURL('popup.html?mode=popout'),
            type: 'popup',
            width: 360,
            height: 700
        });
        window.close();
    });
}

if (sidePanelBtn) {
    sidePanelBtn.addEventListener('click', async () => {
        try {
            const tab = await getCor3Tab();
            if (!tab) { statusDiv.textContent = '未找到 cor3.gg 标签页。'; return; }
            await chrome.sidePanel.open({ tabId: tab.id });
            window.close();
        } catch (e) {
            statusDiv.textContent = '此浏览器不支持侧边栏。';
        }
    });
}
