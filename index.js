/**
 * Nov Style Engine - index.js
 * SillyTavern 문체 지침 프롬프트 자동 주입 확장
 * https://github.com/pointhuh-netizen/nov-style
 */

(async () => {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 0. 상수                                                              */
    /* ------------------------------------------------------------------ */

    const EXTENSION_NAME = 'nov-style';
    const UNUSED_SUFFIX   = '-00';
    const PROMPT_TITLE    = '# 문체 지침';
    const BUILD_ORDER     = ['W', 'A', 'S', 'B', 'C', 'D', 'E', 'F', 'G'];

    /* ------------------------------------------------------------------ */
    /* 1. ST 전역 API 획득                                                  */
    /* ------------------------------------------------------------------ */

    let eventSource, event_types, saveSettingsDebounced, extensionSettings, callGenericPopup;

    function acquireSTApi() {
        try {
            const ctx = SillyTavern.getContext();
            eventSource           = ctx.eventSource;
            event_types           = ctx.event_types;
            saveSettingsDebounced = ctx.saveSettingsDebounced;
            extensionSettings     = ctx.extensionSettings;
            callGenericPopup      = ctx.callGenericPopup ?? window.callGenericPopup;
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] SillyTavern.getContext() 실패, 전역 폴백 사용:`, e);
            // 폴백: 전역 변수 직접 참조 (구버전 ST 대응)
            eventSource           = window.eventSource;
            event_types           = window.event_types;
            saveSettingsDebounced = window.saveSettingsDebounced ?? (() => {});
            extensionSettings     = window.extension_settings ?? {};
            callGenericPopup      = window.callGenericPopup;
        }
    }

    acquireSTApi();

    /* ------------------------------------------------------------------ */
    /* 2. 확장 루트 경로 감지                                               */
    /* ------------------------------------------------------------------ */

    let _extensionRoot = null;

    async function getExtensionRoot() {
        if (_extensionRoot) return _extensionRoot;
        const candidates = [
            `/extensions/third-party/${EXTENSION_NAME}`,
            `/scripts/extensions/third-party/${EXTENSION_NAME}`,
        ];
        for (const path of candidates) {
            try {
                const res = await fetch(`${path}/manifest.json`, { method: 'HEAD' });
                if (res.ok) {
                    _extensionRoot = path;
                    return _extensionRoot;
                }
            } catch (e) { console.debug(`[${EXTENSION_NAME}] 경로 ${path} 감지 실패:`, e.message); }
        }
        _extensionRoot = candidates[0];
        return _extensionRoot;
    }

    /* ------------------------------------------------------------------ */
    /* 3. JSON fetch 헬퍼                                                   */
    /* ------------------------------------------------------------------ */

    async function fetchJSON(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
        return res.json();
    }

    /* ------------------------------------------------------------------ */
    /* 4. 데이터 로드                                                        */
    /* ------------------------------------------------------------------ */

    let _data = null;

    async function loadData() {
        if (_data) return _data;
        const root = await getExtensionRoot();

        let catalog, masterRules;
        try {
            [catalog, masterRules] = await Promise.all([
                fetchJSON(`${root}/data/catalog.json`),
                fetchJSON(`${root}/data/master-rules.json`),
            ]);
        } catch (err) {
            throw new Error(`카탈로그/마스터 규칙 로드 실패: ${err.message}`);
        }

        // 축 파일 로드 (axis key → file)
        const axisFileMap = {};
        for (const m of catalog.modules) {
            if (!axisFileMap[m.axis]) axisFileMap[m.axis] = m.file;
        }

        const axes = {};
        await Promise.all(
            Object.entries(axisFileMap).map(async ([key, file]) => {
                try {
                    axes[key] = await fetchJSON(`${root}/data/${file}`);
                } catch (err) {
                    console.warn(`[${EXTENSION_NAME}] 축 ${key} 로드 실패:`, err.message);
                }
            })
        );

        // Config 파일 로드
        const configs = {};
        await Promise.all(
            catalog.configs.map(async (cfg) => {
                try {
                    configs[cfg.id] = await fetchJSON(`${root}/data/${cfg.file}`);
                } catch (err) {
                    console.warn(`[${EXTENSION_NAME}] Config ${cfg.id} 로드 실패:`, err.message);
                }
            })
        );

        _data = { catalog, masterRules, axes, configs };
        return _data;
    }

    /* ------------------------------------------------------------------ */
    /* 5. 설정 저장 (extension_settings 사용)                              */
    /* ------------------------------------------------------------------ */

    const DEFAULT_SETTINGS = {
        enabled: true,
        selections: {
            axes: {},
            configs: {},
        },
    };

    function getSettings() {
        if (!extensionSettings[EXTENSION_NAME]) {
            extensionSettings[EXTENSION_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
        const s = extensionSettings[EXTENSION_NAME];
        if (s.enabled === undefined) s.enabled = true;
        if (!s.selections) s.selections = { axes: {}, configs: {} };
        if (!s.selections.axes) s.selections.axes = {};
        if (!s.selections.configs) s.selections.configs = {};
        return s;
    }

    function saveSettings() {
        try {
            saveSettingsDebounced?.();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] 설정 저장 실패:`, e);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 6. 선택 상태 헬퍼                                                    */
    /* ------------------------------------------------------------------ */

    function getAxisSelection(axisKey, axisType) {
        const s = getSettings().selections.axes;
        if (axisType === 'mutex') return s[axisKey] ?? null;
        return s[axisKey] ?? [];
    }

    function setAxisSelection(axisKey, value) {
        getSettings().selections.axes[axisKey] = value;
    }

    function getConfigSelection(configId) {
        return getSettings().selections.configs[configId] ?? null;
    }

    function setConfigSelection(configId, modeId) {
        getSettings().selections.configs[configId] = modeId;
    }

    function resetSelections() {
        const s = getSettings();
        s.selections = { axes: {}, configs: {} };
    }

    /* ------------------------------------------------------------------ */
    /* 7. 빌드 엔진                                                          */
    /* ------------------------------------------------------------------ */

    function extractModuleTexts(moduleObj) {
        const texts = [];
        if (!moduleObj) return texts;

        // operations.slot.value 형태 (실제 데이터 구조)
        if (moduleObj.operations && typeof moduleObj.operations === 'object') {
            for (const op of Object.values(moduleObj.operations)) {
                const val = op?.value;
                if (val && typeof val === 'string' && val.trim()) {
                    texts.push(val.trim());
                }
            }
        }

        // 대체 필드 체크
        if (texts.length === 0) {
            for (const field of ['system_prompt', 'prompt', 'rules', 'content', 'text']) {
                const val = moduleObj[field];
                if (val && typeof val === 'string' && val.trim()) {
                    texts.push(val.trim());
                    break;
                }
            }
        }

        return texts;
    }

    function extractConfigTexts(modeObj) {
        const texts = [];
        if (!modeObj) return texts;

        const inj = modeObj.injections;
        if (inj && typeof inj === 'object') {
            for (const field of ['preamble_core_directives_add', 'static_MODULE_1_VOICE_add']) {
                if (Array.isArray(inj[field])) {
                    texts.push(...inj[field].filter(Boolean));
                }
            }
            for (const field of ['master_rules_godmoding_override', 'master_rules_lethal_override']) {
                if (inj[field] && typeof inj[field] === 'string') {
                    texts.push(inj[field]);
                }
            }
        }

        if (modeObj.operations && typeof modeObj.operations === 'object') {
            for (const op of Object.values(modeObj.operations)) {
                const val = op?.value;
                if (val && typeof val === 'string' && val.trim()) {
                    texts.push(val.trim());
                }
            }
        }

        return texts;
    }

    function buildMasterRulesSection(masterRules) {
        const lines = [];

        if (masterRules.supreme_rule) {
            lines.push(`[최고 규칙] ${masterRules.supreme_rule}`);
        }
        if (Array.isArray(masterRules.core_directives)) {
            lines.push(...masterRules.core_directives);
        }

        const fp = masterRules.forbidden_patterns;
        if (fp && typeof fp === 'object') {
            for (const pattern of Object.values(fp)) {
                if (pattern?.rule) lines.push(`[금지 패턴 ${pattern.id}] ${pattern.rule}`);
            }
        }

        const fv = masterRules.forbidden_vocabulary;
        if (fv && typeof fv === 'object') {
            const entries = Object.entries(fv)
                .map(([word, alts]) => `"${word}" → ${Array.isArray(alts) ? alts.join('/') : alts}`)
                .join(', ');
            if (entries) lines.push(`[금지 어휘 → 대체] ${entries}`);
        }

        if (masterRules.emotion_naming_ban) {
            lines.push(`[감정 명명 금지] ${masterRules.emotion_naming_ban}`);
        }

        const dc = masterRules.dialogue_constraints;
        if (dc) {
            if (dc.correction) lines.push(`[대화 교정 원칙] ${dc.correction}`);
            if (dc.flow_rule)  lines.push(`[대화 흐름] ${dc.flow_rule}`);
        }

        return lines.join('\n');
    }

    function buildPrompt(data) {
        const { catalog, masterRules, axes, configs } = data;
        const sections = [];

        // 1. 마스터 규칙
        const masterText = buildMasterRulesSection(masterRules);
        if (masterText) {
            sections.push(`## 핵심 규칙\n${masterText}`);
        }

        // 2. 축별 선택 모듈
        for (const axisKey of BUILD_ORDER) {
            const axisMeta = catalog.axes[axisKey];
            if (!axisMeta) continue;

            const axisData = axes[axisKey];
            if (!axisData) continue;

            const isCombinable = axisMeta.type === 'combinable';
            let selectedIds;

            if (isCombinable) {
                selectedIds = getAxisSelection(axisKey, 'combinable');
                if (!Array.isArray(selectedIds) || selectedIds.length === 0) continue;
            } else {
                const sel = getAxisSelection(axisKey, 'mutex');
                if (!sel || sel.endsWith(UNUSED_SUFFIX)) continue;
                selectedIds = [sel];
            }

            const modulesInAxis = Array.isArray(axisData.modules) ? axisData.modules : [];

            for (const moduleId of selectedIds) {
                if (!moduleId || moduleId.endsWith(UNUSED_SUFFIX)) continue;

                const moduleObj = modulesInAxis.find(m => m.id === moduleId);
                if (!moduleObj) continue;

                const texts = extractModuleTexts(moduleObj);
                if (texts.length === 0) continue;

                const axisLabel = `${axisMeta.icon ?? ''} ${axisMeta.name_ko} [${axisKey}축]`;
                sections.push(`## ${axisLabel} — ${moduleObj.name}\n${texts.join('\n')}`);
            }
        }

        // 3. Config 지침
        for (const cfgMeta of catalog.configs) {
            const cfgId = cfgMeta.id;
            const selectedMode = getConfigSelection(cfgId);
            if (!selectedMode || selectedMode.endsWith(UNUSED_SUFFIX)) continue;

            const cfgData = configs[cfgId];
            if (!cfgData) continue;

            const modeObj = (cfgData.modes ?? []).find(m => m.id === selectedMode);
            if (!modeObj) continue;

            const texts = extractConfigTexts(modeObj);
            if (texts.length === 0) continue;

            const cfgLabel = `${cfgMeta.icon ?? ''} ${cfgMeta.name_ko}`;
            sections.push(`## ${cfgLabel} — ${modeObj.name}\n${texts.join('\n')}`);
        }

        if (sections.length === 0) return '';
        return `${PROMPT_TITLE}\n\n${sections.join('\n\n')}`;
    }

    /* ------------------------------------------------------------------ */
    /* 8. 프롬프트 주입                                                      */
    /* ------------------------------------------------------------------ */

    function injectPrompt(promptText) {
        try {
            let ctx;
            try { ctx = SillyTavern.getContext(); } catch (e) {
                console.debug(`[${EXTENSION_NAME}] getContext() 실패, 전역 폴백:`, e.message);
            }

            const setFn = ctx?.setExtensionPrompt ?? window.setExtensionPrompt;
            if (typeof setFn !== 'function') return false;

            // type=IN_PROMPT(1), depth=0, scan=false, role=SYSTEM(0)
            setFn(EXTENSION_NAME, promptText, 1, 0, false, 0);
            return true;
        } catch (e) {
            console.error(`[${EXTENSION_NAME}] 프롬프트 주입 실패:`, e);
            return false;
        }
    }

    /* ------------------------------------------------------------------ */
    /* 9. 팝업 UI 빌드                                                       */
    /* ------------------------------------------------------------------ */

    function buildPopupElement(data) {
        const { catalog, axes, configs } = data;
        const el = document.createElement('div');
        el.className = 'nov-style-popup';

        // Mutex 축 섹션
        const mutexSection = document.createElement('div');
        mutexSection.className = 'nov-style-popup-section';
        const mutexTitle = document.createElement('div');
        mutexTitle.className = 'nov-style-popup-section-title';
        mutexTitle.textContent = '── Mutex 축 (하나만 선택) ──';
        mutexSection.appendChild(mutexTitle);

        // Combinable 축 섹션
        const combSection = document.createElement('div');
        combSection.className = 'nov-style-popup-section';
        const combTitle = document.createElement('div');
        combTitle.className = 'nov-style-popup-section-title';
        combTitle.textContent = '── Combinable 축 (복수 선택) ──';
        combSection.appendChild(combTitle);

        for (const axisKey of BUILD_ORDER) {
            const axisMeta = catalog.axes[axisKey];
            if (!axisMeta) continue;

            const modulesForAxis = catalog.modules.filter(m => m.axis === axisKey);
            if (modulesForAxis.length === 0) continue;

            const isCombinable = axisMeta.type === 'combinable';
            const groupEl = document.createElement('div');
            groupEl.className = 'nov-style-popup-axis-group';

            const labelEl = document.createElement('div');
            labelEl.className = 'nov-style-popup-axis-label';
            labelEl.textContent = `${axisMeta.icon ?? ''} ${axisMeta.name_ko} (${axisMeta.name_en})`;
            groupEl.appendChild(labelEl);

            if (isCombinable) {
                const collapseHeader = document.createElement('div');
                collapseHeader.className = 'nov-style-popup-collapse-header';

                const toggleIcon = document.createElement('span');
                toggleIcon.className = 'nov-style-popup-collapse-toggle fa-solid fa-chevron-right';
                collapseHeader.appendChild(toggleIcon);

                const selectedIds = getAxisSelection(axisKey, 'combinable');
                const selCount = Array.isArray(selectedIds)
                    ? selectedIds.filter(id => !id.endsWith(UNUSED_SUFFIX)).length
                    : 0;
                const badge = document.createElement('span');
                badge.className = 'nov-style-popup-count-badge';
                badge.textContent = selCount > 0 ? `${selCount}개 선택됨` : '선택 없음';
                collapseHeader.appendChild(badge);

                groupEl.appendChild(collapseHeader);

                const listEl = document.createElement('div');
                listEl.className = 'nov-style-popup-checkbox-list collapsed';

                for (const mod of modulesForAxis) {
                    if (mod.id.endsWith(UNUSED_SUFFIX)) continue;

                    const itemLabel = document.createElement('label');
                    itemLabel.className = 'nov-style-popup-checkbox-item';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.value = mod.id;
                    cb.dataset.axis = axisKey;
                    const currentSel = getAxisSelection(axisKey, 'combinable');
                    cb.checked = Array.isArray(currentSel) && currentSel.includes(mod.id);

                    cb.addEventListener('change', () => {
                        const arr = [...(getAxisSelection(axisKey, 'combinable') ?? [])];
                        if (cb.checked) {
                            if (!arr.includes(mod.id)) arr.push(mod.id);
                        } else {
                            const idx = arr.indexOf(mod.id);
                            if (idx >= 0) arr.splice(idx, 1);
                        }
                        setAxisSelection(axisKey, arr);
                        const cnt = arr.filter(id => !id.endsWith(UNUSED_SUFFIX)).length;
                        badge.textContent = cnt > 0 ? `${cnt}개 선택됨` : '선택 없음';
                    });

                    const textSpan = document.createElement('span');
                    textSpan.className = 'nov-style-popup-mod-name';
                    textSpan.textContent = mod.name;

                    const olSpan = document.createElement('span');
                    olSpan.className = 'nov-style-popup-mod-oneliner';
                    olSpan.textContent = mod.one_liner ?? '';

                    const textWrapper = document.createElement('span');
                    textWrapper.appendChild(textSpan);
                    textWrapper.appendChild(olSpan);

                    itemLabel.appendChild(cb);
                    itemLabel.appendChild(textWrapper);
                    listEl.appendChild(itemLabel);
                }

                collapseHeader.addEventListener('click', () => {
                    const isCollapsed = listEl.classList.toggle('collapsed');
                    toggleIcon.classList.toggle('fa-chevron-right', isCollapsed);
                    toggleIcon.classList.toggle('fa-chevron-down', !isCollapsed);
                });

                groupEl.appendChild(listEl);
                combSection.appendChild(groupEl);
            } else {
                const selectEl = document.createElement('select');
                selectEl.className = 'nov-style-popup-select';
                selectEl.dataset.axis = axisKey;

                const currentSel = getAxisSelection(axisKey, 'mutex');

                for (const mod of modulesForAxis) {
                    const opt = document.createElement('option');
                    opt.value = mod.id;
                    opt.textContent = mod.name;
                    opt.title = mod.one_liner ?? '';
                    if (mod.id === currentSel) opt.selected = true;
                    selectEl.appendChild(opt);
                }

                const oneLinerEl = document.createElement('div');
                oneLinerEl.className = 'nov-style-popup-oneliner';
                const initMod = modulesForAxis.find(
                    m => m.id === (currentSel ?? modulesForAxis[0]?.id)
                );
                oneLinerEl.textContent = initMod?.one_liner ?? '';

                selectEl.addEventListener('change', () => {
                    setAxisSelection(axisKey, selectEl.value);
                    const selMod = modulesForAxis.find(m => m.id === selectEl.value);
                    oneLinerEl.textContent = selMod?.one_liner ?? '';
                });

                groupEl.appendChild(selectEl);
                groupEl.appendChild(oneLinerEl);
                mutexSection.appendChild(groupEl);
            }
        }

        // Config 섹션
        const cfgSection = document.createElement('div');
        cfgSection.className = 'nov-style-popup-section';
        const cfgTitle = document.createElement('div');
        cfgTitle.className = 'nov-style-popup-section-title';
        cfgTitle.textContent = '── ⚙️ 기본 설정 (Config) ──';
        cfgSection.appendChild(cfgTitle);

        for (const cfgMeta of catalog.configs) {
            const cfgData = configs[cfgMeta.id];
            if (!cfgData) continue;

            const groupEl = document.createElement('div');
            groupEl.className = 'nov-style-popup-axis-group';

            const labelEl = document.createElement('div');
            labelEl.className = 'nov-style-popup-axis-label';
            labelEl.textContent = `${cfgMeta.icon ?? ''} ${cfgMeta.name_ko}`;
            groupEl.appendChild(labelEl);

            const currentSel = getConfigSelection(cfgMeta.id);
            const modes = cfgData.modes ?? [];

            const btnGroup = document.createElement('div');
            btnGroup.className = 'nov-style-config-btn-group';
            btnGroup.dataset.configId = cfgMeta.id;

            const oneLinerEl = document.createElement('div');
            oneLinerEl.className = 'nov-style-popup-oneliner';
            const initMode = (!currentSel || currentSel.endsWith('-00'))
                ? null
                : modes.find(m => m.id === currentSel);
            oneLinerEl.textContent = initMode?.one_liner ?? '';

            for (const mode of modes) {
                // -00 (사용하지 않음)은 버튼에 표시하지 않음
                if (mode.id.endsWith('-00')) continue;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nov-style-config-btn';
                btn.dataset.modeId = mode.id;
                btn.textContent = mode.name;
                btn.title = mode.one_liner ?? '';

                if (mode.id === currentSel) {
                    btn.classList.add('active');
                }

                btn.addEventListener('click', () => {
                    const wasActive = btn.classList.contains('active');
                    btnGroup.querySelectorAll('.nov-style-config-btn').forEach(b => b.classList.remove('active'));

                    if (wasActive) {
                        // 해제 → -00 (사용하지 않음)으로 자동 복귀
                        const defaultMode = modes.find(m => m.id.endsWith('-00'))?.id ?? null;
                        setConfigSelection(cfgMeta.id, defaultMode);
                        oneLinerEl.textContent = '';
                    } else {
                        btn.classList.add('active');
                        setConfigSelection(cfgMeta.id, mode.id);
                        oneLinerEl.textContent = mode.one_liner ?? '';
                    }
                });

                btnGroup.appendChild(btn);
            }

            groupEl.appendChild(btnGroup);
            groupEl.appendChild(oneLinerEl);
            cfgSection.appendChild(groupEl);
        }

        el.appendChild(cfgSection);
        el.appendChild(mutexSection);
        el.appendChild(combSection);

        // 미리보기 섹션
        const previewSection = document.createElement('div');
        previewSection.className = 'nov-style-popup-section';
        const previewTitle = document.createElement('div');
        previewTitle.className = 'nov-style-popup-section-title nov-style-popup-preview-toggle';
        previewTitle.textContent = '👁️ 프롬프트 미리보기';
        previewSection.appendChild(previewTitle);

        const previewTextarea = document.createElement('textarea');
        previewTextarea.className = 'nov-style-popup-preview';
        previewTextarea.readOnly = true;
        previewTextarea.placeholder = '클릭하면 미리보기가 표시됩니다';
        previewSection.appendChild(previewTextarea);

        previewTitle.addEventListener('click', () => {
            const promptText = buildPrompt(data);
            previewTextarea.value = promptText || '(선택된 문체 없음)';
            previewTextarea.classList.toggle('visible');
        });

        el.appendChild(previewSection);

        // 액션 버튼
        const actionsEl = document.createElement('div');
        actionsEl.className = 'nov-style-popup-actions';

        const applyBtn = document.createElement('button');
        applyBtn.className = 'menu_button nov-style-popup-apply-btn';
        applyBtn.textContent = '✅ 적용';

        const resetBtn = document.createElement('button');
        resetBtn.className = 'menu_button';
        resetBtn.textContent = '🔄 초기화';

        actionsEl.appendChild(applyBtn);
        actionsEl.appendChild(resetBtn);
        el.appendChild(actionsEl);

        const popupStatusEl = document.createElement('div');
        popupStatusEl.className = 'nov-style-popup-status';
        el.appendChild(popupStatusEl);

        applyBtn.addEventListener('click', () => {
            const promptText = buildPrompt(data);
            if (!promptText) {
                popupStatusEl.textContent = '⚠️ 선택된 문체가 없습니다. 하나 이상 선택하세요.';
                popupStatusEl.className = 'nov-style-popup-status error';
                return;
            }
            const ok = injectPrompt(promptText);
            if (ok) {
                const count = promptText.split('##').length - 1;
                popupStatusEl.textContent = `✅ 적용됨 — ${count}개 섹션, ${promptText.length}자`;
                popupStatusEl.className = 'nov-style-popup-status applied';
                updateSidebarStatus(`✅ 적용됨 — ${count}개 섹션`, true);
            } else {
                popupStatusEl.textContent = '❌ 주입 실패 (ST API 없음). 콘솔을 확인하세요.';
                popupStatusEl.className = 'nov-style-popup-status error';
            }
            saveSettings();
        });

        resetBtn.addEventListener('click', () => {
            resetSelections();
            syncPopupFromSelections(el, catalog);
            injectPrompt('');
            popupStatusEl.textContent = '🔄 초기화됨';
            popupStatusEl.className = 'nov-style-popup-status';
            updateSidebarStatus('적용된 빌드 없음');
            saveSettings();
        });

        return el;
    }

    function syncPopupFromSelections(popupEl, catalog) {
        for (const [axisKey, axisMeta] of Object.entries(catalog.axes)) {
            if (axisMeta.type !== 'mutex') continue;
            const sel = getAxisSelection(axisKey, 'mutex');
            const selectEl = popupEl.querySelector(
                `select.nov-style-popup-select[data-axis="${axisKey}"]`
            );
            if (selectEl) {
                selectEl.value = sel ?? selectEl.options[0]?.value ?? '';
                selectEl.dispatchEvent(new Event('change'));
            }
        }

        for (const [axisKey, axisMeta] of Object.entries(catalog.axes)) {
            if (axisMeta.type !== 'combinable') continue;
            const selectedIds = getAxisSelection(axisKey, 'combinable');
            const cbs = popupEl.querySelectorAll(
                `input[type="checkbox"][data-axis="${axisKey}"]`
            );
            let cnt = 0;
            cbs.forEach(cb => {
                cb.checked = Array.isArray(selectedIds) && selectedIds.includes(cb.value);
                if (cb.checked) cnt++;
            });
            // badge update
            const group = cbs[0]?.closest('.nov-style-popup-axis-group');
            const badge = group?.querySelector('.nov-style-popup-count-badge');
            if (badge) badge.textContent = cnt > 0 ? `${cnt}개 선택됨` : '선택 없음';
        }

        const configBtnGroups = popupEl.querySelectorAll(
            '.nov-style-config-btn-group[data-config-id]'
        );
        configBtnGroups.forEach(group => {
            const cfgId = group.dataset.configId;
            const val = getConfigSelection(cfgId);
            group.querySelectorAll('.nov-style-config-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.modeId === val);
            });
        });
    }

    /* ------------------------------------------------------------------ */
    /* 10. 사이드바 상태 업데이트                                           */
    /* ------------------------------------------------------------------ */

    function updateSidebarStatus(text, isApplied = false, isError = false) {
        const el = document.getElementById('nov-style-status');
        if (!el) return;
        el.textContent = text;
        el.className = 'nov-style-status';
        if (isApplied) el.classList.add('applied');
        if (isError)   el.classList.add('error');
    }

    /* ------------------------------------------------------------------ */
    /* 11. 팝업 열기                                                         */
    /* ------------------------------------------------------------------ */

    async function openSettingsPopup() {
        if (!_data) {
            if (typeof toastr !== 'undefined') {
                toastr.warning('Nov Style Engine: 데이터를 로드 중입니다. 잠시 후 다시 시도하세요.');
            }
            return;
        }

        const popupEl = buildPopupElement(_data);

        if (typeof callGenericPopup === 'function') {
            try {
                await callGenericPopup(popupEl, 0, '', {
                    wide: true,
                    large: true,
                    allowVerticalScrolling: true,
                });
                return;
            } catch (e) {
                console.warn(`[${EXTENSION_NAME}] callGenericPopup 실패, 폴백 사용:`, e);
            }
        }

        showFallbackModal(popupEl);
    }

    function showFallbackModal(contentEl) {
        const existing = document.getElementById('nov-style-fallback-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'nov-style-fallback-modal';
        overlay.className = 'nov-style-modal-overlay';

        const modal = document.createElement('div');
        modal.className = 'nov-style-modal-dialog';

        const header = document.createElement('div');
        header.className = 'nov-style-modal-header';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = '🎨 Nov Style Engine';
        header.appendChild(titleSpan);

        const closeBtn = document.createElement('button');
        closeBtn.className = 'nov-style-modal-close menu_button';
        closeBtn.textContent = '✕';
        closeBtn.addEventListener('click', () => overlay.remove());
        header.appendChild(closeBtn);

        const body = document.createElement('div');
        body.className = 'nov-style-modal-body';
        body.appendChild(contentEl);

        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) overlay.remove();
        });

        modal.appendChild(header);
        modal.appendChild(body);
        overlay.appendChild(modal);
        document.body.appendChild(overlay);
    }

    /* ------------------------------------------------------------------ */
    /* 12. 채팅 변경 이벤트                                                 */
    /* ------------------------------------------------------------------ */

    function onChatChanged() {
        const s = getSettings();
        if (!s.enabled || !_data) return;
        const promptText = buildPrompt(_data);
        if (promptText) {
            injectPrompt(promptText);
            const count = promptText.split('##').length - 1;
            updateSidebarStatus(`✅ 적용됨 — ${count}개 섹션`, true);
        }
    }

    /* ------------------------------------------------------------------ */
    /* 13. 설정 패널 HTML 로드 및 초기화                                   */
    /* ------------------------------------------------------------------ */

    async function initSettingsPanel() {
        const root = await getExtensionRoot();
        let settingsHtml = null;
        try {
            const res = await fetch(`${root}/settings.html`);
            if (res.ok) settingsHtml = await res.text();
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] settings.html fetch 실패:`, e.message);
        }

        if (!settingsHtml) {
            console.error(`[${EXTENSION_NAME}] settings.html 로드 실패`);
            return;
        }

        const targetEl = document.querySelector('#extensions_settings2, #extensions_settings');
        if (!targetEl) {
            console.warn(`[${EXTENSION_NAME}] 설정 패널 컨테이너를 찾을 수 없습니다.`);
            return;
        }

        if (document.getElementById('nov-style-settings')) return;

        targetEl.insertAdjacentHTML('beforeend', settingsHtml);

        const enabledCb = document.getElementById('nov-style-enabled');
        if (enabledCb) {
            enabledCb.checked = getSettings().enabled;
            enabledCb.addEventListener('change', () => {
                getSettings().enabled = enabledCb.checked;
                if (!enabledCb.checked) {
                    injectPrompt('');
                    updateSidebarStatus('비활성화됨');
                } else if (_data) {
                    const promptText = buildPrompt(_data);
                    if (promptText) {
                        injectPrompt(promptText);
                        const count = promptText.split('##').length - 1;
                        updateSidebarStatus(`✅ 적용됨 — ${count}개 섹션`, true);
                    }
                }
                saveSettings();
            });
        }

        const openPopupBtn = document.getElementById('nov-style-open-popup');
        if (openPopupBtn) {
            openPopupBtn.addEventListener('click', () => openSettingsPopup());
        }
    }

    /* ------------------------------------------------------------------ */
    /* 14. 진입점                                                           */
    /* ------------------------------------------------------------------ */

    async function init() {
        console.log(`[${EXTENSION_NAME}] 초기화 시작`);

        await initSettingsPanel();

        let data;
        try {
            data = await loadData();
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] 데이터 로드 실패:`, err);
            updateSidebarStatus(`❌ 데이터 로드 실패: ${err.message}`, false, true);
            if (typeof toastr !== 'undefined') {
                toastr.error(`Nov Style Engine: 데이터 로드 실패 — ${err.message}`);
            }
            return;
        }

        const s = getSettings();
        if (s.enabled) {
            const promptText = buildPrompt(data);
            if (promptText) {
                injectPrompt(promptText);
                const count = promptText.split('##').length - 1;
                updateSidebarStatus(`✅ 적용됨 — ${count}개 섹션`, true);
            }
        } else {
            updateSidebarStatus('비활성화됨');
        }

        if (eventSource && event_types) {
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        }

        console.log(`[${EXTENSION_NAME}] 초기화 완료`);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        await init();
    }

})();
