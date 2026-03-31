/**
 * Nov Style Engine - index.js
 * SillyTavern 문체 지침 프롬프트 자동 주입 확장
 * https://github.com/pointhuh-netizen/nov-style
 */

(async () => {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 0. ST 전역 API 획득                                                  */
    /* ------------------------------------------------------------------ */

    const EXTENSION_NAME = 'nov-style';

    let eventSource, event_types, saveSettingsDebounced, getContext;

    try {
        const ctx = SillyTavern.getContext();
        eventSource          = ctx.eventSource;
        event_types          = ctx.event_types;
        saveSettingsDebounced = ctx.saveSettingsDebounced;
        getContext           = ctx.getContext ?? (() => SillyTavern.getContext());
    } catch (e) {
        console.error(`[${EXTENSION_NAME}] SillyTavern.getContext() 실패:`, e);
        // 폴백: 전역 변수 직접 참조 (구버전 ST 대응)
        eventSource          = window.eventSource;
        event_types          = window.event_types;
        saveSettingsDebounced = window.saveSettingsDebounced ?? (() => {});
        getContext           = () => ({
            chat: window.chat,
            chat_metadata: window.chat_metadata,
            setExtensionPrompt: window.setExtensionPrompt,
        });
    }

    /* ------------------------------------------------------------------ */
    /* 1. 확장 루트 경로 감지                                               */
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
            } catch (_) { /* 다음 경로 시도 */ }
        }
        // 감지 실패 시 신규 경로로 폴백
        _extensionRoot = candidates[0];
        return _extensionRoot;
    }

    /* ------------------------------------------------------------------ */
    /* 2. JSON fetch 헬퍼                                                   */
    /* ------------------------------------------------------------------ */

    async function fetchJSON(url) {
        const res = await fetch(url);
        if (!res.ok) throw new Error(`HTTP ${res.status} — ${url}`);
        return res.json();
    }

    /* ------------------------------------------------------------------ */
    /* 3. 데이터 로드                                                        */
    /* ------------------------------------------------------------------ */

    let _data = null; // { catalog, masterRules, axes, configs }

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

        // 축 파일 로드 (축 key → file 경로)
        const axisFileMap = {};
        for (const m of catalog.modules) {
            if (!axisFileMap[m.axis]) axisFileMap[m.axis] = m.file;
        }

        const axes = {};
        const axisErrors = [];
        await Promise.all(
            Object.entries(axisFileMap).map(async ([key, file]) => {
                try {
                    axes[key] = await fetchJSON(`${root}/data/${file}`);
                } catch (err) {
                    axisErrors.push(`축 ${key} (${file}): ${err.message}`);
                }
            })
        );

        if (axisErrors.length > 0) {
            console.warn(`[${EXTENSION_NAME}] 축 로드 일부 실패:`, axisErrors);
        }

        // Config 파일 로드
        const configs = {};
        const configErrors = [];
        await Promise.all(
            catalog.configs.map(async (cfg) => {
                try {
                    configs[cfg.id] = await fetchJSON(`${root}/data/${cfg.file}`);
                } catch (err) {
                    configErrors.push(`Config ${cfg.id}: ${err.message}`);
                }
            })
        );

        if (configErrors.length > 0) {
            console.warn(`[${EXTENSION_NAME}] Config 로드 일부 실패:`, configErrors);
        }

        _data = { catalog, masterRules, axes, configs };
        return _data;
    }

    /* ------------------------------------------------------------------ */
    /* 4. 선택 상태 관리                                                    */
    /* ------------------------------------------------------------------ */

    // selections: { A: 'A-01', S: null, B: null, C: ['C-01'], D: [], ... }
    // configs:    { user_character_control: 'UCC-00', nsfw_rating: 'NSFW-00', lethal_protocol: 'LETHAL-00' }
    const DEFAULT_SELECTIONS = {
        axes: {},   // axis key → module id (mutex) or [module ids] (combinable)
        configs: {}, // config id → mode id
    };

    let _selections = JSON.parse(JSON.stringify(DEFAULT_SELECTIONS));

    function getAxisSelection(axisKey, axisType) {
        if (axisType === 'mutex') {
            return _selections.axes[axisKey] ?? null;
        } else {
            return _selections.axes[axisKey] ?? [];
        }
    }

    function setAxisSelection(axisKey, axisType, value) {
        _selections.axes[axisKey] = value;
    }

    function getConfigSelection(configId) {
        return _selections.configs[configId] ?? null;
    }

    function setConfigSelection(configId, modeId) {
        _selections.configs[configId] = modeId;
    }

    function resetSelections() {
        _selections = JSON.parse(JSON.stringify(DEFAULT_SELECTIONS));
    }

    /* ------------------------------------------------------------------ */
    /* 5. 채팅별 저장/복원                                                  */
    /* ------------------------------------------------------------------ */

    const META_KEY = `${EXTENSION_NAME}_selections`;

    function saveSelectionsToChat() {
        try {
            const ctx = getContext();
            if (ctx?.chat_metadata) {
                ctx.chat_metadata[META_KEY] = JSON.parse(JSON.stringify(_selections));
                saveSettingsDebounced?.();
            }
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] 설정 저장 실패:`, e);
        }
    }

    function loadSelectionsFromChat() {
        try {
            const ctx = getContext();
            if (ctx?.chat_metadata?.[META_KEY]) {
                _selections = JSON.parse(JSON.stringify(ctx.chat_metadata[META_KEY]));
                return true;
            }
        } catch (e) {
            console.warn(`[${EXTENSION_NAME}] 설정 복원 실패:`, e);
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* 6. 빌드 엔진                                                          */
    /* ------------------------------------------------------------------ */

    /**
     * 모듈의 operations에서 텍스트를 추출하여 배열로 반환
     */
    function extractModuleTexts(moduleObj) {
        const texts = [];
        if (!moduleObj?.operations) return texts;
        for (const [slotKey, op] of Object.entries(moduleObj.operations)) {
            const val = op?.value;
            if (val && typeof val === 'string' && val.trim()) {
                texts.push(val.trim());
            }
        }
        return texts;
    }

    /**
     * Config 모드의 injections에서 텍스트를 추출
     */
    function extractConfigTexts(modeObj) {
        const texts = [];
        if (!modeObj?.injections) return texts;
        const inj = modeObj.injections;

        // preamble_core_directives_add
        if (Array.isArray(inj.preamble_core_directives_add)) {
            texts.push(...inj.preamble_core_directives_add.filter(Boolean));
        }
        // static_MODULE_1_VOICE_add
        if (Array.isArray(inj.static_MODULE_1_VOICE_add)) {
            texts.push(...inj.static_MODULE_1_VOICE_add.filter(Boolean));
        }
        // master_rules_godmoding_override
        if (inj.master_rules_godmoding_override && typeof inj.master_rules_godmoding_override === 'string') {
            texts.push(inj.master_rules_godmoding_override);
        }
        // master_rules_lethal_override
        if (inj.master_rules_lethal_override && typeof inj.master_rules_lethal_override === 'string') {
            texts.push(inj.master_rules_lethal_override);
        }
        // operations values (some configs store prompt text in operations)
        if (modeObj.operations) {
            for (const [, op] of Object.entries(modeObj.operations)) {
                const val = op?.value;
                if (val && typeof val === 'string' && val.trim()) {
                    texts.push(val.trim());
                }
            }
        }
        return texts;
    }

    /**
     * 마스터 규칙 텍스트 빌드
     */
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
            for (const [, pattern] of Object.entries(fp)) {
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

    /**
     * 전체 프롬프트 빌드
     */
    function buildPrompt(data) {
        const { catalog, masterRules, axes, configs } = data;
        const sections = [];

        // 1. 마스터 규칙
        const masterText = buildMasterRulesSection(masterRules);
        if (masterText) {
            sections.push(`## 핵심 규칙\n${masterText}`);
        }

        // 2. 축별 선택 모듈 — 빌드 순서: W → A → S → B → C → D → E → F → G
        const BUILD_ORDER = ['W', 'A', 'S', 'B', 'C', 'D', 'E', 'F', 'G'];

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
                if (!sel || sel.endsWith('-00')) continue; // "사용하지 않음"
                selectedIds = [sel];
            }

            for (const moduleId of selectedIds) {
                // -00은 "사용하지 않음"
                if (moduleId && moduleId.endsWith('-00')) continue;

                const moduleObj = axisData.modules?.find(m => m.id === moduleId);
                if (!moduleObj) continue;

                const texts = extractModuleTexts(moduleObj);
                if (texts.length === 0) continue;

                const axisLabel = `${axisMeta.icon ?? ''} ${axisMeta.name_ko} [${axisKey}축]`;
                const moduleLabel = moduleObj.name;
                sections.push(`## ${axisLabel} — ${moduleLabel}\n${texts.join('\n')}`);
            }
        }

        // 3. Config 지침
        for (const cfgMeta of catalog.configs) {
            const cfgId = cfgMeta.id;
            const selectedMode = getConfigSelection(cfgId);
            if (!selectedMode || selectedMode.endsWith('-00')) continue;

            const cfgData = configs[cfgId];
            if (!cfgData) continue;

            const modeObj = cfgData.modes?.find(m => m.id === selectedMode);
            if (!modeObj) continue;

            const texts = extractConfigTexts(modeObj);
            if (texts.length === 0) continue;

            const cfgLabel = `${cfgMeta.icon ?? ''} ${cfgMeta.name_ko}`;
            sections.push(`## ${cfgLabel} — ${modeObj.name}\n${texts.join('\n')}`);
        }

        if (sections.length === 0) return '';
        return `# 문체 지침\n\n${sections.join('\n\n')}`;
    }

    /* ------------------------------------------------------------------ */
    /* 7. 프롬프트 주입                                                      */
    /* ------------------------------------------------------------------ */

    function injectPrompt(promptText) {
        try {
            const ctx = getContext();
            if (typeof ctx?.setExtensionPrompt === 'function') {
                ctx.setExtensionPrompt(EXTENSION_NAME, promptText, 1, 0);
                return true;
            }
            // 폴백: 전역 함수
            if (typeof window.setExtensionPrompt === 'function') {
                window.setExtensionPrompt(EXTENSION_NAME, promptText, 1, 0);
                return true;
            }
        } catch (e) {
            console.error(`[${EXTENSION_NAME}] 프롬프트 주입 실패:`, e);
        }
        return false;
    }

    /* ------------------------------------------------------------------ */
    /* 8. UI 렌더링                                                          */
    /* ------------------------------------------------------------------ */

    function renderAxisSection(catalog, axes) {
        const container = document.getElementById('nov-style-axes');
        if (!container) return;
        container.innerHTML = '';

        const BUILD_ORDER = ['W', 'A', 'S', 'B', 'C', 'D', 'E', 'F', 'G'];

        for (const axisKey of BUILD_ORDER) {
            const axisMeta = catalog.axes[axisKey];
            if (!axisMeta) continue;

            const axisData = axes[axisKey];
            const modulesForAxis = catalog.modules.filter(m => m.axis === axisKey);
            if (modulesForAxis.length === 0) continue;

            const isCombinable = axisMeta.type === 'combinable';

            const groupEl = document.createElement('div');
            groupEl.className = 'nov-style-axis-group';

            // Header
            const headerEl = document.createElement('div');
            headerEl.className = 'nov-style-axis-header collapsed';
            headerEl.innerHTML = `
                <span>${axisMeta.icon ?? ''}</span>
                <span>${axisMeta.name_ko}</span>
                <span class="nov-style-type-badge">${isCombinable ? '복수 선택' : '단일 선택'}</span>
                <span class="nov-style-axis-toggle fa-solid fa-chevron-down"></span>
            `;

            // Body
            const bodyEl = document.createElement('div');
            bodyEl.className = 'nov-style-axis-body collapsed';

            if (axisMeta.ui_description) {
                const descEl = document.createElement('div');
                descEl.className = 'nov-style-axis-desc';
                descEl.textContent = axisMeta.ui_description;
                bodyEl.appendChild(descEl);
            }

            if (isCombinable) {
                // Checkbox list
                const listEl = document.createElement('div');
                listEl.className = 'nov-style-checkbox-list';

                const selectedIds = getAxisSelection(axisKey, 'combinable');

                for (const mod of modulesForAxis) {
                    const itemEl = document.createElement('label');
                    itemEl.className = 'nov-style-checkbox-item';

                    const cb = document.createElement('input');
                    cb.type = 'checkbox';
                    cb.value = mod.id;
                    cb.dataset.axis = axisKey;
                    cb.checked = Array.isArray(selectedIds) && selectedIds.includes(mod.id);

                    cb.addEventListener('change', () => {
                        const current = getAxisSelection(axisKey, 'combinable');
                        const arr = Array.isArray(current) ? [...current] : [];
                        if (cb.checked) {
                            if (!arr.includes(mod.id)) arr.push(mod.id);
                        } else {
                            const idx = arr.indexOf(mod.id);
                            if (idx >= 0) arr.splice(idx, 1);
                        }
                        setAxisSelection(axisKey, 'combinable', arr);
                    });

                    const labelText = document.createElement('span');
                    labelText.innerHTML = `${mod.name}<span class="one-liner">${mod.one_liner ?? ''}</span>`;

                    itemEl.appendChild(cb);
                    itemEl.appendChild(labelText);
                    listEl.appendChild(itemEl);
                }
                bodyEl.appendChild(listEl);
            } else {
                // Select dropdown
                const selectEl = document.createElement('select');
                selectEl.className = 'nov-style-select';
                selectEl.dataset.axis = axisKey;

                const currentSel = getAxisSelection(axisKey, 'mutex');

                for (const mod of modulesForAxis) {
                    const opt = document.createElement('option');
                    opt.value = mod.id;
                    opt.textContent = `${mod.name}`;
                    opt.title = mod.one_liner ?? '';
                    if (mod.id === currentSel) opt.selected = true;
                    selectEl.appendChild(opt);
                }

                selectEl.addEventListener('change', () => {
                    setAxisSelection(axisKey, 'mutex', selectEl.value);
                });

                bodyEl.appendChild(selectEl);

                // one_liner for selected module
                const oneLinerEl = document.createElement('div');
                oneLinerEl.className = 'nov-style-axis-desc';
                oneLinerEl.style.marginTop = '4px';
                oneLinerEl.textContent = modulesForAxis.find(m => m.id === (currentSel ?? modulesForAxis[0]?.id))?.one_liner ?? '';
                bodyEl.appendChild(oneLinerEl);

                selectEl.addEventListener('change', () => {
                    const selMod = modulesForAxis.find(m => m.id === selectEl.value);
                    oneLinerEl.textContent = selMod?.one_liner ?? '';
                });
            }

            // Toggle collapse
            headerEl.addEventListener('click', () => {
                const collapsed = bodyEl.classList.toggle('collapsed');
                headerEl.classList.toggle('collapsed', collapsed);
            });

            groupEl.appendChild(headerEl);
            groupEl.appendChild(bodyEl);
            container.appendChild(groupEl);
        }
    }

    function renderConfigSection(catalog, configs) {
        const container = document.getElementById('nov-style-configs');
        if (!container) return;
        container.innerHTML = '';

        const headerEl = document.createElement('div');
        headerEl.className = 'nov-style-configs-header';
        headerEl.textContent = '⚙️ 컨피그 설정';
        container.appendChild(headerEl);

        for (const cfgMeta of catalog.configs) {
            const cfgData = configs[cfgMeta.id];
            if (!cfgData) continue;

            const itemEl = document.createElement('div');
            itemEl.className = 'nov-style-config-item';

            const labelEl = document.createElement('label');
            labelEl.textContent = `${cfgMeta.icon ?? ''} ${cfgMeta.name_ko}`;
            itemEl.appendChild(labelEl);

            const selectEl = document.createElement('select');
            selectEl.className = 'nov-style-select';
            selectEl.dataset.configId = cfgMeta.id;

            const currentSel = getConfigSelection(cfgMeta.id);

            for (const mode of (cfgData.modes ?? [])) {
                const opt = document.createElement('option');
                opt.value = mode.id;
                opt.textContent = mode.name;
                opt.title = mode.one_liner ?? '';
                if (mode.id === currentSel) opt.selected = true;
                selectEl.appendChild(opt);
            }

            selectEl.addEventListener('change', () => {
                setConfigSelection(cfgMeta.id, selectEl.value);
            });

            itemEl.appendChild(selectEl);

            // one_liner display
            const oneLinerEl = document.createElement('div');
            oneLinerEl.className = 'nov-style-axis-desc';
            oneLinerEl.style.marginTop = '3px';
            const initialMode = cfgData.modes?.find(m => m.id === (currentSel ?? cfgData.modes[0]?.id));
            oneLinerEl.textContent = initialMode?.one_liner ?? '';
            itemEl.appendChild(oneLinerEl);

            selectEl.addEventListener('change', () => {
                const selMode = cfgData.modes?.find(m => m.id === selectEl.value);
                oneLinerEl.textContent = selMode?.one_liner ?? '';
            });

            container.appendChild(itemEl);
        }
    }

    function syncUIFromSelections(catalog) {
        // Sync axis selects/checkboxes
        for (const [axisKey, axisMeta] of Object.entries(catalog.axes)) {
            if (axisMeta.type === 'mutex') {
                const sel = getAxisSelection(axisKey, 'mutex');
                const selectEl = document.querySelector(`select.nov-style-select[data-axis="${axisKey}"]`);
                if (selectEl && sel) selectEl.value = sel;
            } else {
                const selectedIds = getAxisSelection(axisKey, 'combinable');
                const cbs = document.querySelectorAll(`input[type="checkbox"][data-axis="${axisKey}"]`);
                cbs.forEach(cb => {
                    cb.checked = Array.isArray(selectedIds) && selectedIds.includes(cb.value);
                });
            }
        }
        // Sync config selects
        const configSelects = document.querySelectorAll('select.nov-style-select[data-config-id]');
        configSelects.forEach(sel => {
            const cfgId = sel.dataset.configId;
            const val = getConfigSelection(cfgId);
            if (val) sel.value = val;
        });
    }

    /* ------------------------------------------------------------------ */
    /* 9. 이벤트 핸들러 등록                                                */
    /* ------------------------------------------------------------------ */

    function registerEventHandlers(data) {
        const { catalog, masterRules, axes, configs } = data;

        // 적용 버튼
        const applyBtn = document.getElementById('nov-style-apply');
        if (applyBtn) {
            applyBtn.addEventListener('click', () => {
                const promptText = buildPrompt(data);
                const statusEl = document.getElementById('nov-style-status');

                if (!promptText) {
                    if (statusEl) {
                        statusEl.textContent = '⚠️ 선택된 문체가 없습니다. 축을 하나 이상 선택하세요.';
                        statusEl.className = 'nov-style-status error';
                    }
                    return;
                }

                const ok = injectPrompt(promptText);
                if (statusEl) {
                    if (ok) {
                        const count = promptText.split('##').length - 1;
                        statusEl.textContent = `✅ 적용됨 — ${count}개 섹션, ${promptText.length}자`;
                        statusEl.className = 'nov-style-status applied';
                    } else {
                        statusEl.textContent = '❌ 주입 실패 (ST API 없음). 콘솔을 확인하세요.';
                        statusEl.className = 'nov-style-status error';
                    }
                }

                saveSelectionsToChat();
            });
        }

        // 미리보기 버튼
        const previewBtn = document.getElementById('nov-style-preview-btn');
        const previewTextarea = document.getElementById('nov-style-preview-text');
        if (previewBtn && previewTextarea) {
            previewBtn.addEventListener('click', () => {
                const promptText = buildPrompt(data);
                previewTextarea.value = promptText || '(선택된 문체 없음)';
                previewTextarea.classList.toggle('visible', true);
            });
        }

        // 초기화 버튼
        const resetBtn = document.getElementById('nov-style-reset');
        if (resetBtn) {
            resetBtn.addEventListener('click', () => {
                resetSelections();
                syncUIFromSelections(catalog);
                injectPrompt(''); // 주입된 프롬프트 제거
                const statusEl = document.getElementById('nov-style-status');
                if (statusEl) {
                    statusEl.textContent = '🔄 초기화됨';
                    statusEl.className = 'nov-style-status';
                }
                if (previewTextarea) {
                    previewTextarea.value = '';
                    previewTextarea.classList.remove('visible');
                }
                saveSelectionsToChat();
            });
        }
    }

    /* ------------------------------------------------------------------ */
    /* 10. 채팅 전환 이벤트                                                 */
    /* ------------------------------------------------------------------ */

    function onChatChanged() {
        const loaded = loadSelectionsFromChat();
        if (!_data) return;
        syncUIFromSelections(_data.catalog);

        const statusEl = document.getElementById('nov-style-status');
        if (statusEl) {
            statusEl.textContent = loaded ? '💾 이전 설정 복원됨' : '적용된 빌드 없음';
            statusEl.className = 'nov-style-status';
        }
    }

    /* ------------------------------------------------------------------ */
    /* 11. 설정 패널 HTML 로드 및 초기화                                   */
    /* ------------------------------------------------------------------ */

    async function initSettingsPanel() {
        const root = await getExtensionRoot();
        const settingsHtml = await (async () => {
            try {
                const res = await fetch(`${root}/settings.html`);
                if (res.ok) return res.text();
            } catch (_) {}
            return null;
        })();

        if (!settingsHtml) {
            console.error(`[${EXTENSION_NAME}] settings.html 로드 실패`);
            return;
        }

        // ST 설정 패널에 삽입
        const targetSelector = '#extensions_settings2, #extensions_settings';
        const target = document.querySelector(targetSelector);
        if (!target) {
            console.warn(`[${EXTENSION_NAME}] 설정 패널 컨테이너를 찾을 수 없습니다.`);
            return;
        }

        // 이미 삽입된 경우 중복 방지
        if (document.getElementById('nov-style-settings')) return;

        target.insertAdjacentHTML('beforeend', settingsHtml);
    }

    /* ------------------------------------------------------------------ */
    /* 12. 진입점                                                           */
    /* ------------------------------------------------------------------ */

    async function init() {
        console.log(`[${EXTENSION_NAME}] 초기화 시작`);

        // 설정 패널 HTML 로드
        await initSettingsPanel();

        // 로딩 표시
        const loadingEl = document.getElementById('nov-style-loading');
        const axesSection = document.getElementById('nov-style-axes');
        const configsSection = document.getElementById('nov-style-configs');

        // 데이터 로드
        let data;
        try {
            data = await loadData();
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] 데이터 로드 실패:`, err);
            if (loadingEl) {
                loadingEl.innerHTML = `❌ 데이터 로드 실패: ${err.message}`;
                loadingEl.style.color = '#e07070';
            }
            if (typeof toastr !== 'undefined') {
                toastr.error(`Nov Style Engine: 데이터 로드 실패 — ${err.message}`);
            }
            return;
        }

        // 로딩 숨기기
        if (loadingEl) loadingEl.style.display = 'none';
        if (axesSection) axesSection.style.display = '';
        if (configsSection) configsSection.style.display = '';

        const { catalog, axes, configs } = data;

        // UI 렌더링
        renderAxisSection(catalog, axes);
        renderConfigSection(catalog, configs);

        // 채팅 복원
        const restored = loadSelectionsFromChat();
        if (restored) {
            syncUIFromSelections(catalog);
            const statusEl = document.getElementById('nov-style-status');
            if (statusEl) {
                statusEl.textContent = '💾 이전 설정 복원됨';
                statusEl.className = 'nov-style-status';
            }
        }

        // 이벤트 핸들러 등록
        registerEventHandlers(data);

        // 채팅 전환 이벤트 구독
        if (eventSource && event_types) {
            eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
        }

        console.log(`[${EXTENSION_NAME}] 초기화 완료`);
    }

    // ST가 준비되면 초기화 실행
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        // 이미 로드된 경우
        await init();
    }

})();
