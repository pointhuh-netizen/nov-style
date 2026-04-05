/**
 * Nov Style Lite — 어조·어휘 (index.js)
 * SillyTavern B축(어조·어휘) 전용 경량 확장
 * https://github.com/pointhuh-netizen/nov-style
 */

(async () => {
    'use strict';

    /* ------------------------------------------------------------------ */
    /* 0. 상수                                                              */
    /* ------------------------------------------------------------------ */

    const EXTENSION_NAME = 'style_nov';
    const UNUSED_SUFFIX   = '-00';
    const PROMPT_TITLE    = '# 문체 지침';
    const BUILD_ORDER     = ['B'];

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

        // delta-resolution.json 로드 (실패 시 fallback)
        let deltaResolution = { default_strategy: 'last_axis_wins', rules: [] };
        try {
            deltaResolution = await fetchJSON(`${root}/data/delta-resolution.json`);
        } catch (err) {
            console.warn(`[${EXTENSION_NAME}] delta-resolution.json 로드 실패 (fallback 사용):`, err.message);
        }

        _data = { catalog, masterRules, axes, deltaResolution };
        return _data;
    }

    /* ------------------------------------------------------------------ */
    /* 5. 설정 저장 (extension_settings 사용)                              */
    /* ------------------------------------------------------------------ */

    const DEFAULT_SETTINGS = {
        enabled: true,
        theme: 'light',
        selections: {
            axes: {},
        },
    };

    function getSettings() {
        if (!extensionSettings[EXTENSION_NAME]) {
            extensionSettings[EXTENSION_NAME] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
        }
        const s = extensionSettings[EXTENSION_NAME];
        if (s.enabled === undefined) s.enabled = true;
        if (!s.theme) s.theme = 'light';
        if (!s.selections) s.selections = { axes: {} };
        if (!s.selections.axes) s.selections.axes = {};
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

    function resetSelections() {
        const s = getSettings();
        s.selections = { axes: {} };
    }

    /* ------------------------------------------------------------------ */
    /* 6b. 테마 헬퍼                                                         */
    /* ------------------------------------------------------------------ */

    function applyTheme(theme) {
        const container = document.getElementById('style-nov-settings');
        if (container) container.dataset.novTheme = theme;
    }

    function updateThemeToggleBtn(btn, theme) {
        if (theme === 'dark') {
            btn.innerHTML = '<i class="fa-solid fa-sun"></i> 라이트 모드';
        } else {
            btn.innerHTML = '<i class="fa-solid fa-moon"></i> 다크 모드';
        }
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

    function applyMasterGuideDelta(masterRules, delta) {
        // forbidden_patterns
        if (delta.forbidden_patterns && masterRules.forbidden_patterns) {
            for (const [typeKey, override] of Object.entries(delta.forbidden_patterns)) {
                if (typeKey === '_engine_status') continue;
                if (!masterRules.forbidden_patterns[typeKey]) continue;
                const overrideType = override.override;
                if (overrideType === 'LIFT') {
                    delete masterRules.forbidden_patterns[typeKey];
                } else if (overrideType === 'PARTIAL_LIFT' || overrideType === 'SOFTEN') {
                    masterRules.forbidden_patterns[typeKey] = {
                        ...masterRules.forbidden_patterns[typeKey],
                        rule: override.note,
                    };
                } else if (overrideType === 'MODIFY') {
                    masterRules.forbidden_patterns[typeKey] = {
                        ...masterRules.forbidden_patterns[typeKey],
                        rule: override.new_rule,
                    };
                }
            }
        }

        // forbidden_vocabulary
        if (delta.forbidden_vocabulary && masterRules.forbidden_vocabulary) {
            const { lifted_entries } = delta.forbidden_vocabulary;
            if (Array.isArray(lifted_entries)) {
                for (const entry of lifted_entries) {
                    delete masterRules.forbidden_vocabulary[entry];
                }
            }
        }

        // subtext_rules
        if (delta.subtext_rules && masterRules.subtext_rules) {
            for (const [fieldKey, override] of Object.entries(delta.subtext_rules)) {
                if (fieldKey === '_engine_status') continue;
                const overrideType = override.override;
                if (overrideType === 'LIFT') {
                    delete masterRules.subtext_rules[fieldKey];
                } else if (overrideType === 'PARTIAL_LIFT' || overrideType === 'SOFTEN') {
                    masterRules.subtext_rules[fieldKey] = override.note;
                } else if (overrideType === 'MODIFY') {
                    masterRules.subtext_rules[fieldKey] = override.new_rule;
                }
            }
        }

        // anti_archetype_rules
        if (delta.anti_archetype_rules && masterRules.anti_archetype_rules) {
            for (const [fieldKey, override] of Object.entries(delta.anti_archetype_rules)) {
                if (fieldKey === '_engine_status') continue;
                const overrideType = override.override;
                if (overrideType === 'LIFT') {
                    delete masterRules.anti_archetype_rules[fieldKey];
                } else if (overrideType === 'PARTIAL_LIFT' || overrideType === 'SOFTEN') {
                    masterRules.anti_archetype_rules[fieldKey] = override.note;
                } else if (overrideType === 'MODIFY') {
                    masterRules.anti_archetype_rules[fieldKey] = override.new_rule;
                }
            }
        }

        // self_check_overrides
        if (Array.isArray(delta.self_check_overrides) && masterRules.self_check && Array.isArray(masterRules.self_check.checks)) {
            for (const op of delta.self_check_overrides) {
                const { target_id, override: overrideType, new_rule } = op;
                const idx = masterRules.self_check.checks.findIndex(c => c.id === target_id);
                if (idx === -1) continue;
                if (overrideType === 'LIFT') {
                    masterRules.self_check.checks.splice(idx, 1);
                } else if (overrideType === 'MODIFY') {
                    masterRules.self_check.checks[idx] = {
                        ...masterRules.self_check.checks[idx],
                        rule: new_rule,
                    };
                }
            }
        }
    }

    function buildMasterRulesSection(masterRules, dynamicChecks = []) {
        const lines = [];

        if (masterRules.supreme_rule) {
            lines.push(`[SUPREME_RULE] ${masterRules.supreme_rule}`);
        }
        if (masterRules.premise) {
            lines.push(`[PREMISE] ${masterRules.premise}`);
        }
        if (masterRules.layer_principle) {
            lines.push(`[LAYER_PRINCIPLE] ${masterRules.layer_principle}`);
        }
        if (masterRules.priority_cascade) {
            lines.push(`[PRIORITY_CASCADE] ${masterRules.priority_cascade}`);
        }
        if (Array.isArray(masterRules.core_directives)) {
            lines.push(...masterRules.core_directives);
        }

        const fp = masterRules.forbidden_patterns;
        if (fp && typeof fp === 'object') {
            for (const pattern of Object.values(fp)) {
                if (pattern?.rule) lines.push(`[FORBIDDEN_PATTERN:${pattern.id}] ${pattern.rule}`);
            }
        }

        const fv = masterRules.forbidden_vocabulary;
        if (fv && typeof fv === 'object') {
            const entries = Object.entries(fv)
                .map(([word, alts]) => `"${word}" → ${Array.isArray(alts) ? alts.join('/') : alts}`)
                .join(', ');
            if (entries) lines.push(`[BANNED_VOCAB] ${entries}`);
        }

        const dc = masterRules.dialogue_constraints;
        if (dc) {
            const fvs = dc.forbidden_vectors;
            if (fvs && typeof fvs === 'object') {
                lines.push('');
                lines.push('[FORBIDDEN_VECTORS]');
                if (dc.constraint) lines.push(`CONSTRAINT: ${dc.constraint}`);
                for (const vec of Object.values(fvs)) {
                    const label = vec.label || vec.id;
                    lines.push(`  - ${label}: "${vec.pattern}" (금지)`);
                }
                if (dc.correction) lines.push(`  * 교정법: ${dc.correction}`);
            }
            if (dc.flow_rule) lines.push(`[DIALOGUE_FLOW] ${dc.flow_rule}`);
        }

        const df = masterRules.dialogue_format;
        if (df) {
            lines.push('');
            lines.push('[DIALOGUE_FORMAT]');
            if (df.quotation)    lines.push(`[QUOTATION] ${df.quotation}`);
            if (df.tag_policy)   lines.push(`[TAG_POLICY] ${df.tag_policy}`);
            if (df.default_tag)  lines.push(`[DEFAULT_TAG] ${df.default_tag}`);
        }

        const ne = masterRules.narrative_enrichment;
        if (ne) {
            lines.push('');
            lines.push('[NARRATIVE_ENRICHMENT]');
            if (ne.foundation) lines.push(ne.foundation);
            if (Array.isArray(ne.axes)) {
                for (const axis of ne.axes) lines.push(`  - ${axis}`);
            }
            if (ne.density_control) lines.push(`[DENSITY_CTRL] ${ne.density_control}`);
            if (Array.isArray(ne.invention_principles)) {
                for (const p of ne.invention_principles) lines.push(`  · ${p}`);
            }
            if (ne.user_priority) lines.push(`[USER_PRIORITY] ${ne.user_priority}`);
        }

        const st = masterRules.subtext_rules;
        if (st) {
            lines.push('');
            lines.push('[SUBTEXT]');
            if (st.emotion_naming_ban) lines.push(`[NO_EMOTION_NAMING] ${st.emotion_naming_ban}`);
            if (st.emotion_action_ban) lines.push(`[NO_EMOTION_ACTION_MAP] ${st.emotion_action_ban}`);
            if (st.insertion_frequency) lines.push(`[SUBTEXT_FREQ] ${st.insertion_frequency}`);
            if (st.contradiction_display) lines.push(`[CONTRADICTION] ${st.contradiction_display}`);
        } else if (masterRules.emotion_naming_ban) {
            lines.push(`[NO_EMOTION_NAMING] ${masterRules.emotion_naming_ban}`);
        }

        const aa = masterRules.anti_archetype_rules;
        if (aa) {
            lines.push('');
            lines.push('[ANTI_ARCHETYPE]');
            if (aa.top3_ban) lines.push(`[TOP3_BAN] ${aa.top3_ban}`);
            if (aa.fourth_option) lines.push(`[4TH_OPTION] ${aa.fourth_option}`);
            if (aa.archetype_proving_ban) lines.push(`[NO_ARCHETYPE_PROVING] ${aa.archetype_proving_ban}`);
        }

        const cf = masterRules.character_flaw_rules;
        if (cf) {
            lines.push('');
            lines.push('[FLAW_ENGINE]');
            if (cf.ai_morality_ban) lines.push(`[NO_AI_MORALITY] ${cf.ai_morality_ban}`);
            if (cf.flaw_activation) lines.push(`[FLAW_ACTIVATION] ${cf.flaw_activation}`);
            if (cf.severity_guardrail) lines.push(`[SEVERITY_GUARD] ${cf.severity_guardrail}`);
        }

        const ec = masterRules.emotional_continuity;
        if (ec) {
            lines.push('');
            lines.push('[EMOTIONAL_CONTINUITY]');
            if (ec.residue_rule) lines.push(`[RESIDUE] ${ec.residue_rule}`);
            if (ec.residue_duration) lines.push(`[RESIDUE_DURATION] ${ec.residue_duration}`);
            if (ec.physical_vs_emotional) lines.push(`[PHYS_VS_EMO] ${ec.physical_vs_emotional}`);
            if (ec.relationship_temperature) lines.push(`[REL_TEMP] ${ec.relationship_temperature}`);
            if (ec.arc_progression) lines.push(`[ARC_PROGRESS] ${ec.arc_progression}`);
            if (ec.active_past_linking) lines.push(`[ACTIVE_PAST_LINK] ${ec.active_past_linking}`);
        }

        const cm = masterRules.cognitive_model;
        if (cm) {
            lines.push('');
            lines.push('[COGNITIVE_MODEL]');
            if (cm.npc_layered_response) lines.push(`[NPC_LAYERED_RESPONSE] ${cm.npc_layered_response}`);
            if (cm.layers) lines.push(`[LAYERS] ${cm.layers}`);
            const ip = cm.inner_process;
            if (ip) {
                if (ip.rule) lines.push(`[INNER_PROCESS] ${ip.rule}`);
                if (Array.isArray(ip.types)) {
                    for (const t of ip.types) lines.push(`  ${t}`);
                }
            }
            if (cm.setting_causality) lines.push(`[SETTING_CAUSALITY] ${cm.setting_causality}`);
            if (cm.perception_gap)    lines.push(`[PERCEPTION_GAP] ${cm.perception_gap}`);
        }

        const se = masterRules.specificity_engine;
        if (se) {
            lines.push('');
            lines.push('[SPECIFICITY_ENGINE]');
            if (se.foundation) lines.push(se.foundation);
            const ta = se.three_axes;
            if (ta && typeof ta === 'object') {
                for (const axisText of Object.values(ta)) {
                    if (axisText) lines.push(`  ${axisText}`);
                }
            }
            if (se.density)          lines.push(`[SPECIFICITY_DENSITY] ${se.density}`);
            if (se.emotional_climax) lines.push(`[EMOTIONAL_CLIMAX] ${se.emotional_climax}`);
        }

        const tf = masterRules.tense_and_format;
        if (tf) {
            lines.push('');
            lines.push('[TENSE_AND_FORMAT]');
            if (tf.tense)          lines.push(`[TENSE] ${tf.tense}`);
            if (tf.grammar)        lines.push(`[GRAMMAR] ${tf.grammar}`);
            if (tf.vocabulary_ref) lines.push(tf.vocabulary_ref);
            if (tf.formatting)     lines.push(`[FORMATTING] ${tf.formatting}`);
        }

        const sc = masterRules.self_check;
        if (sc) {
            lines.push('');
            lines.push('[SELF_CHECK]');
            if (sc.preamble) lines.push(sc.preamble);
            const staticChecks = Array.isArray(sc.checks) ? sc.checks : [];
            const allChecks = [...staticChecks, ...dynamicChecks];
            for (const chk of allChecks) {
                if (chk?.id && chk?.rule) {
                    const cat = chk.category ? `:${chk.category}` : '';
                    lines.push(`[${chk.id}${cat}] ${chk.rule}`);
                }
            }
            if (sc.note) lines.push(`[CHECK_NOTE] ${sc.note}`);
        }

        return lines.join('\n');
    }

    function buildPrompt(data) {
        const { catalog, masterRules, axes } = data;
        const sections = [];
        const dynamicChecks = [];
        const pendingDeltas = [];

        // 축별 선택 모듈
        for (const axisKey of BUILD_ORDER) {
            const axisMeta = catalog.axes[axisKey];
            if (!axisMeta) continue;

            const axisData = axes[axisKey];
            if (!axisData) continue;

            const sel = getAxisSelection(axisKey, 'mutex');
            if (!sel || sel.endsWith(UNUSED_SUFFIX)) continue;

            const modulesInAxis = Array.isArray(axisData.modules) ? axisData.modules : [];

            const moduleObj = modulesInAxis.find(m => m.id === sel);
            if (!moduleObj) continue;

            // check_operations 수집 — mode:'ADD' 항목만 self_check에 병합
            if (Array.isArray(moduleObj.check_operations)) {
                for (const op of moduleObj.check_operations) {
                    if (op?.mode === 'ADD' && op?.check) {
                        dynamicChecks.push(op.check);
                    }
                }
            }

            // master_guide_delta 수집 (BUILD_ORDER 순, last_axis_wins)
            if (moduleObj.master_guide_delta && typeof moduleObj.master_guide_delta === 'object') {
                const delta = moduleObj.master_guide_delta;
                const hasContent = Object.keys(delta).some(k => k !== '_engine_status');
                if (hasContent) {
                    pendingDeltas.push(delta);
                }
            }

            const texts = extractModuleTexts(moduleObj);
            if (texts.length === 0) continue;

            const axisLabel = `${axisMeta.name_ko} [${axisKey}축]`;
            sections.push(`## ${axisLabel} — ${moduleObj.name}\n${texts.join('\n')}`);
        }

        // master_guide_delta 적용 (delta가 있으면 클론 생성 후 순서대로 적용)
        let effectiveMasterRules = masterRules;
        if (pendingDeltas.length > 0) {
            effectiveMasterRules = JSON.parse(JSON.stringify(masterRules));
            for (const delta of pendingDeltas) {
                applyMasterGuideDelta(effectiveMasterRules, delta);
            }
        }

        const masterText = buildMasterRulesSection(effectiveMasterRules, dynamicChecks);
        if (masterText) {
            sections.unshift(`## 핵심 규칙\n${masterText}`);
        }

        if (sections.length === 0) return '';
        return `${PROMPT_TITLE}\n\n${sections.join('\n\n')}`;
    }

    /* ------------------------------------------------------------------ */
    /* 8. 프롬프트 주입                                                      */
    /* ------------------------------------------------------------------ */

    /**
     * 한국어+영어 혼합 텍스트의 토큰 수를 보수적으로 추정한다.
     * 한국어: ~1.5자/token, 영문/기호/공백: ~4자/token
     */
    function estimateTokens(text) {
        const koreanChars = (text.match(/[\uAC00-\uD7AF\u3130-\u318F\u1100-\u11FF]/g) || []).length;
        const nonKoreanChars = text.length - koreanChars;
        return Math.ceil(koreanChars / 1.5 + nonKoreanChars / 4);
    }

    function formatSectionStatus(promptText) {
        const totalSections = promptText.split('##').length - 1;
        const userSections = totalSections - 1; // 마스터룰(핵심 규칙) 제외
        return userSections > 0
            ? `기본 설정값 + ${userSections}개 섹션`
            : '기본 설정값';
    }

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
        const { catalog, axes } = data;
        const el = document.createElement('div');
        el.className = 'nov-style-popup';

        // B축(어조·어휘) 섹션
        const mutexSection = document.createElement('div');
        mutexSection.className = 'nov-style-popup-section';
        const mutexTitle = document.createElement('div');
        mutexTitle.className = 'nov-style-popup-section-title';
        mutexTitle.textContent = '── 어조 · 어휘 ──';
        mutexSection.appendChild(mutexTitle);

        for (const axisKey of BUILD_ORDER) {
            const axisMeta = catalog.axes[axisKey];
            if (!axisMeta) continue;

            const modulesForAxis = catalog.modules.filter(m => m.axis === axisKey);
            if (modulesForAxis.length === 0) continue;

            const currentSel = getAxisSelection(axisKey, 'mutex');

            const groupEl = document.createElement('div');
            groupEl.className = 'nov-style-popup-axis-group';

            const labelEl = document.createElement('div');
            labelEl.className = 'nov-style-popup-axis-label';
            labelEl.textContent = `${axisMeta.name_ko} (${axisMeta.name_en})`;
            groupEl.appendChild(labelEl);

            const btnGroup = document.createElement('div');
            btnGroup.className = 'nov-style-mutex-btn-group';
            btnGroup.dataset.axis = axisKey;

            const oneLinerEl = document.createElement('div');
            oneLinerEl.className = 'nov-style-popup-oneliner';
            const initMod = modulesForAxis.find(
                m => m.id === (currentSel ?? null)
            );
            oneLinerEl.textContent = initMod?.one_liner ?? '기존 설정을 그대로 사용합니다.';

            for (const mod of modulesForAxis) {
                if (mod.id.endsWith(UNUSED_SUFFIX)) continue;

                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'nov-style-mutex-btn';
                btn.dataset.modId = mod.id;
                btn.textContent = mod.name;
                btn.title = mod.one_liner ?? '';

                if (mod.id === currentSel) {
                    btn.classList.add('active');
                }

                btn.addEventListener('click', () => {
                    const wasActive = btn.classList.contains('active');
                    btnGroup.querySelectorAll('.nov-style-mutex-btn').forEach(b => b.classList.remove('active'));

                    if (wasActive) {
                        setAxisSelection(axisKey, null);
                        oneLinerEl.textContent = '기존 설정을 그대로 사용합니다.';
                    } else {
                        btn.classList.add('active');
                        setAxisSelection(axisKey, mod.id);
                        oneLinerEl.textContent = mod.one_liner ?? '';
                    }
                });

                btnGroup.appendChild(btn);
            }

            groupEl.appendChild(btnGroup);
            groupEl.appendChild(oneLinerEl);
            mutexSection.appendChild(groupEl);
        }

        el.appendChild(mutexSection);

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
                popupStatusEl.textContent = '⚠️ 선택된 어조가 없습니다. 하나 선택하세요.';
                popupStatusEl.className = 'nov-style-popup-status error';
                return;
            }
            const ok = injectPrompt(promptText);
            if (ok) {
                const sectionLabel = formatSectionStatus(promptText);
                const estimatedTokenCount = estimateTokens(promptText);
                popupStatusEl.innerHTML = `✅ 적용됨 — ${sectionLabel} (≈${estimatedTokenCount.toLocaleString()} tokens)<br><span class="nov-style-token-notice">ℹ️ 이 토큰은 AI 인풋에 포함되지만, SillyTavern의 채팅 토큰 카운터에는 표시되지 않습니다.</span>`;
                popupStatusEl.className = 'nov-style-popup-status applied';
                updateSidebarStatus(`✅ 적용됨 — ${sectionLabel}`, true);
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
            const btnGroup = popupEl.querySelector(
                `.nov-style-mutex-btn-group[data-axis="${axisKey}"]`
            );
            if (btnGroup) {
                const oneLinerEl = btnGroup.closest('.nov-style-popup-axis-group')
                    ?.querySelector('.nov-style-popup-oneliner');
                btnGroup.querySelectorAll('.nov-style-mutex-btn').forEach(btn => {
                    const isActive = btn.dataset.modId === sel;
                    btn.classList.toggle('active', isActive);
                    if (isActive && oneLinerEl) {
                        oneLinerEl.textContent = btn.title;
                    }
                });
                if (!sel && oneLinerEl) {
                    oneLinerEl.textContent = '기존 설정을 그대로 사용합니다.';
                }
            }
        }
    }

    /* ------------------------------------------------------------------ */
    /* 10. 사이드바 상태 업데이트                                           */
    /* ------------------------------------------------------------------ */

    function updateSidebarStatus(text, isApplied = false, isError = false) {
        const el = document.getElementById('style-nov-status');
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
                toastr.warning('문체 조합 확장: 데이터를 로드 중입니다. 잠시 후 다시 시도하세요.');
            }
            return;
        }

        const popupEl = buildPopupElement(_data);
        popupEl.dataset.novTheme = getSettings().theme ?? 'light';

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
        const existing = document.getElementById('style-nov-fallback-modal');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'style-nov-fallback-modal';
        overlay.className = 'nov-style-modal-overlay';
        overlay.dataset.novTheme = getSettings().theme ?? 'light';

        const modal = document.createElement('div');
        modal.className = 'nov-style-modal-dialog';

        const header = document.createElement('div');
        header.className = 'nov-style-modal-header';

        const titleSpan = document.createElement('span');
        titleSpan.textContent = '✍️ 문체 조합 확장';
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
            updateSidebarStatus(`✅ 적용됨 — ${formatSectionStatus(promptText)}`, true);
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

        if (document.getElementById('style-nov-settings')) return;

        targetEl.insertAdjacentHTML('beforeend', settingsHtml);

        // 테마 초기화
        applyTheme(getSettings().theme ?? 'light');

        const themeToggleBtn = document.getElementById('style-nov-theme-toggle');
        if (themeToggleBtn) {
            updateThemeToggleBtn(themeToggleBtn, getSettings().theme ?? 'light');
            themeToggleBtn.addEventListener('click', () => {
                const current = getSettings().theme ?? 'light';
                const next = current === 'light' ? 'dark' : 'light';
                getSettings().theme = next;
                applyTheme(next);
                updateThemeToggleBtn(themeToggleBtn, next);
                saveSettings();
            });
        }

        const enabledCb = document.getElementById('style-nov-enabled');
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
                        updateSidebarStatus(`✅ 적용됨 — ${formatSectionStatus(promptText)}`, true);
                    }
                }
                saveSettings();
            });
        }

        const openPopupBtn = document.getElementById('style-nov-open-popup');
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
                toastr.error(`문체 조합 확장: 데이터 로드 실패 — ${err.message}`);
            }
            return;
        }

        const s = getSettings();
        if (s.enabled) {
            const promptText = buildPrompt(data);
            if (promptText) {
                injectPrompt(promptText);
                updateSidebarStatus(`✅ 적용됨 — ${formatSectionStatus(promptText)}`, true);
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
