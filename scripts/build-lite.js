#!/usr/bin/env node
/**
 * build-lite.js
 * 경량(lite) 배포용 데이터 빌드 스크립트
 *
 * - scripts/lite-config.json 설정에 따라 포함할 축(axis)을 선택
 * - data/catalog.json 에서 해당 축만 필터링
 * - 각 축 파일에서 프롬프트 원문을 숨기고 예상 토큰 수를 추가
 * - data/master-rules.json 의 세부 규칙을 redact하여 복사
 * - 결과물을 dist/lite/ 에 저장
 *
 * Usage: node scripts/build-lite.js
 *        npm run build:lite
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─── Redaction placeholders ───────────────────────────────────────────────
const REDACTED_PROMPT    = '[lite: prompt hidden]';
const REDACTED_RULE      = '[lite: rule hidden]';
const REDACTED_DIRECTIVE = '[lite: directive hidden]';
const REDACTED_VOCAB     = '[lite: hidden]';

// ─── 경로 설정 / Path setup ────────────────────────────────────────────────
const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = path.join(__dirname, 'lite-config.json');

// ─── 설정 파일 로드 / Load config ─────────────────────────────────────────
let config;
try {
  config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
} catch (err) {
  console.error('[build-lite] ❌ lite-config.json 읽기 실패:', err.message);
  process.exit(1);
}

const { include_axes, output_dir, lite_mode } = config;

if (!Array.isArray(include_axes) || include_axes.length === 0) {
  console.error('[build-lite] ❌ include_axes 가 비어 있습니다. lite-config.json 을 확인하세요.');
  process.exit(1);
}

const OUTPUT_ROOT = path.resolve(ROOT, output_dir);
const OUTPUT_DATA = path.join(OUTPUT_ROOT, 'data');

// ─── 출력 디렉토리 초기화 / Clean output directory ────────────────────────
console.log(`[build-lite] 🗑  출력 디렉토리 초기화: ${OUTPUT_ROOT}`);
if (fs.existsSync(OUTPUT_ROOT)) {
  fs.rmSync(OUTPUT_ROOT, { recursive: true, force: true });
}
fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
fs.mkdirSync(OUTPUT_DATA, { recursive: true });

// ─── 유틸리티 함수 / Utility functions ───────────────────────────────────

/**
 * JSON 파일을 안전하게 읽어 파싱
 * Safely read and parse a JSON file
 */
function readJSON(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    console.error(`[build-lite] ❌ JSON 읽기 실패 (${filePath}):`, err.message);
    process.exit(1);
  }
}

/**
 * JSON을 파일로 쓰기 (부모 디렉토리 자동 생성)
 * Write JSON to file, creating parent directories as needed
 */
function writeJSON(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 프롬프트 텍스트의 예상 토큰 수를 추정
 * Estimate token count for prompt text.
 * Uses ~3.5 characters per token as a rough approximation for Korean text
 * (based on observed GPT-series cl100k_base tokenizer behavior for Korean).
 * This is an approximation only — actual token counts will vary by tokenizer.
 * @param {number} charCount  total character count of the original prompt text
 * @returns {number}
 */
function estimateTokens(charCount) {
  if (!charCount || charCount <= 0) return 0;
  return Math.ceil(charCount / 3.5);
}

// ─── 1. catalog.json 필터링 / Filter catalog.json ────────────────────────
console.log(`[build-lite] 📋 catalog.json 필터링 중 (포함 축: ${include_axes.join(', ')})`);

const catalogSrc = path.join(ROOT, 'data', 'catalog.json');
const catalog = readJSON(catalogSrc);

// axes 객체에서 include_axes 에 해당하는 것만 남김
// Filter axes object to only included axes
const filteredAxes = {};
for (const axisKey of include_axes) {
  if (catalog.axes && catalog.axes[axisKey]) {
    filteredAxes[axisKey] = catalog.axes[axisKey];
  } else {
    console.warn(`[build-lite] ⚠️  catalog.axes 에 '${axisKey}' 키가 없습니다.`);
  }
}

// modules 배열에서 include_axes 에 해당하는 모듈만 남김
// Filter modules array to only included axes
const filteredModules = (catalog.modules || []).filter(
  (m) => include_axes.includes(m.axis)
);

const liteCatalog = {
  ...catalog,
  axes: filteredAxes,
  modules: filteredModules,
};

const catalogOut = path.join(OUTPUT_DATA, 'catalog.json');
writeJSON(catalogOut, liteCatalog);
console.log(`[build-lite] ✅ catalog.json 작성 완료 (모듈 ${filteredModules.length}개)`);

// ─── 2. 축 파일 처리 / Process axis files ────────────────────────────────
// 필터링된 모듈에서 고유 file 경로 수집
// Collect unique file paths from filtered modules
const axisFiles = [...new Set(filteredModules.map((m) => m.file).filter(Boolean))];

let totalModulesProcessed = 0;
let totalEstimatedTokens = 0;
const writtenFiles = [catalogOut];

for (const relFile of axisFiles) {
  const srcPath = path.join(ROOT, 'data', relFile);
  const outPath = path.join(OUTPUT_DATA, relFile);

  if (!fs.existsSync(srcPath)) {
    console.warn(`[build-lite] ⚠️  축 파일을 찾을 수 없습니다: ${srcPath}`);
    continue;
  }

  const axisData = readJSON(srcPath);
  const processedModules = [];

  for (const mod of axisData.modules || []) {
    // operations 처리: 각 operation의 value를 숨기고 estimated_tokens 계산
    // Process operations: hide prompt values and calculate estimated_tokens
    let rawTokenChars = 0;

    const redactedOperations = {};
    if (mod.operations && typeof mod.operations === 'object') {
      for (const [slot, op] of Object.entries(mod.operations)) {
        // 원문 텍스트 길이를 토큰 추정에 사용
        // Use original text length for token estimation
        if (op && typeof op.value === 'string') {
          rawTokenChars += op.value.length;
        }
        redactedOperations[slot] = {
          ...op,
          value: REDACTED_PROMPT,
        };
      }
    }

    const estimatedTokens = estimateTokens(rawTokenChars);
    totalEstimatedTokens += estimatedTokens;

    // check_operations 처리: rule 텍스트를 숨기고 id/category 만 남김
    // Process check_operations: hide rule text, keep only id and category
    const redactedChecks = (mod.check_operations || []).map((cop) => {
      if (!cop || !cop.check) return cop;
      return {
        ...cop,
        check: {
          id: cop.check.id,
          category: cop.check.category,
          rule: REDACTED_RULE,
          source: cop.check.source,
        },
      };
    });

    // 모듈에서 보존할 필드만 남김
    // Keep only the fields that should be visible in lite mode
    const liteMod = {
      id: mod.id,
      name: mod.name,
      one_liner: mod.one_liner,
      description: mod.description,
      known_conflicts: mod.known_conflicts,
      traits: mod.traits,
      estimated_tokens: estimatedTokens,
    };

    // lite_mode 에서만 redacted 내용 포함
    // Include redacted content only in lite_mode
    if (lite_mode) {
      liteMod.operations = redactedOperations;
      liteMod.check_operations = redactedChecks;
    }

    processedModules.push(liteMod);
    totalModulesProcessed++;
  }

  const liteAxisData = {
    ...axisData,
    modules: processedModules,
  };

  writeJSON(outPath, liteAxisData);
  writtenFiles.push(outPath);
  console.log(`[build-lite] ✅ 축 파일 처리 완료: ${relFile} (모듈 ${processedModules.length}개)`);
}

// ─── 3. master-rules.json 처리 / Process master-rules.json ───────────────
const masterSrc = path.join(ROOT, 'data', 'master-rules.json');
if (fs.existsSync(masterSrc)) {
  console.log('[build-lite] 📜 master-rules.json 처리 중...');

  const masterRules = readJSON(masterSrc);

  // 건축적 메타데이터는 보존, 세부 규칙 내용만 redact
  // Preserve architectural metadata; redact detailed rule content only
  const liteMaster = {
    version: masterRules.version,
    // 아키텍처 관련 필드는 그대로 유지 / Keep architectural fields as-is
    supreme_rule: masterRules.supreme_rule,
    premise: masterRules.premise,
    layer_principle: masterRules.layer_principle,
    priority_cascade: masterRules.priority_cascade,
  };

  // core_directives: 각 항목을 '[lite: directive hidden]' 으로 교체
  // core_directives: replace each item with '[lite: directive hidden]'
  if (Array.isArray(masterRules.core_directives)) {
    liteMaster.core_directives = masterRules.core_directives.map(
      () => REDACTED_DIRECTIVE
    );
  }

  // forbidden_patterns: rule 텍스트만 제거, 구조(id, 키) 유지
  // forbidden_patterns: remove rule text, keep structure (id, key)
  if (masterRules.forbidden_patterns && typeof masterRules.forbidden_patterns === 'object') {
    liteMaster.forbidden_patterns = {};
    for (const [key, fp] of Object.entries(masterRules.forbidden_patterns)) {
      liteMaster.forbidden_patterns[key] = {
        id: fp.id,
        rule: REDACTED_RULE,
      };
    }
  }

  // forbidden_vocabulary: 대체어 목록을 '[lite: hidden]' 으로 교체
  // forbidden_vocabulary: replace replacement lists with '[lite: hidden]'
  if (masterRules.forbidden_vocabulary && typeof masterRules.forbidden_vocabulary === 'object') {
    liteMaster.forbidden_vocabulary = {};
    for (const word of Object.keys(masterRules.forbidden_vocabulary)) {
      liteMaster.forbidden_vocabulary[word] = REDACTED_VOCAB;
    }
  }

  const masterOut = path.join(OUTPUT_DATA, 'master-rules.json');
  writeJSON(masterOut, liteMaster);
  writtenFiles.push(masterOut);
  console.log('[build-lite] ✅ master-rules.json 처리 완료');
} else {
  console.warn('[build-lite] ⚠️  data/master-rules.json 를 찾을 수 없습니다. 건너뜁니다.');
}

// ─── 5. manifest.json 생성 / Generate manifest.json ────────────────────────
console.log('[build-lite] 📄 manifest.json 생성 중...');

const liteManifest = {
  display_name: 'Nov Style Lite — 어조·어휘',
  loading_order: 100,
  requires: [],
  optional: [],
  js: 'index.js',
  css: 'style.css',
  author: 'pointhuh-netizen',
  version: '1.0.0',
  homepageUrl: 'https://github.com/pointhuh-netizen/nov-style',
  auto_update: true,
};

const manifestOut = path.join(OUTPUT_ROOT, 'manifest.json');
writeJSON(manifestOut, liteManifest);
writtenFiles.push(manifestOut);
console.log('[build-lite] ✅ manifest.json 생성 완료');

// ─── 6. style.css 복사 / Copy style.css ─────────────────────────────────
console.log('[build-lite] 🎨 style.css 복사 중...');

const cssSrc = path.join(ROOT, 'style.css');
if (fs.existsSync(cssSrc)) {
  const cssOut = path.join(OUTPUT_ROOT, 'style.css');

  // Copy base CSS and append lite-specific selector aliases for the sidebar panel
  let cssContent = fs.readFileSync(cssSrc, 'utf8');
  cssContent += `
/* ─── Nov Style Lite ID aliases ─── */
#nov-style-lite-settings .menu_button,
#nov-style-lite-settings button.menu_button {
    width: 100%;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    box-sizing: border-box;
    padding: 10px 16px;
    background: var(--nov-bg-panel);
    color: var(--nov-text-main);
    border: 1px solid var(--nov-border);
    border-radius: var(--nov-radius-sm);
    font-size: 0.9em;
    font-weight: 600;
    cursor: pointer;
    transition: var(--nov-transition);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
}

#nov-style-lite-settings .menu_button:hover {
    background: var(--nov-bg-hover);
    transform: translateY(-1px);
    box-shadow: var(--nov-shadow-sm);
}
`;

  fs.writeFileSync(cssOut, cssContent, 'utf8');
  writtenFiles.push(cssOut);
  console.log('[build-lite] ✅ style.css 복사 완료');
} else {
  console.warn('[build-lite] ⚠️  style.css 를 찾을 수 없습니다. 건너뜁니다.');
}

// ─── 7. settings.html 생성 / Generate settings.html ────────────────────────
console.log('[build-lite] 🖼  settings.html 생성 중...');

const liteSettingsHtml = `<div id="nov-style-lite-settings" class="nov-style-container">
    <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <span class="nov-style-title"><b>✍️ Nov Style Lite — 어조·어휘</b></span>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content nov-style-drawer-content">
            <div class="nov-style-sidebar-row">
                <label class="nov-style-enable-label">
                    <input type="checkbox" id="nov-style-lite-enabled" class="nov-style-checkbox">
                    <span>엔진 활성화</span>
                </label>
            </div>
            <button id="nov-style-lite-open-popup" class="menu_button nov-style-btn-primary" title="어조·어휘 설정 팝업을 엽니다">
                <i class="fa-solid fa-gear"></i> 설정 열기
            </button>
            <div id="nov-style-lite-status" class="nov-style-status">적용된 빌드 없음</div>
        </div>
    </div>
</div>
`;

const settingsOut = path.join(OUTPUT_ROOT, 'settings.html');
fs.writeFileSync(settingsOut, liteSettingsHtml, 'utf8');
writtenFiles.push(settingsOut);
console.log('[build-lite] ✅ settings.html 생성 완료');

// ─── 8. index.js 생성 / Copy lite engine ────────────────────────────────────
console.log('[build-lite] ⚙️  index.js 생성 중...');

const indexTemplateSrc = path.join(__dirname, 'lite-index-template.js');
if (fs.existsSync(indexTemplateSrc)) {
  const indexOut = path.join(OUTPUT_ROOT, 'index.js');
  fs.copyFileSync(indexTemplateSrc, indexOut);
  writtenFiles.push(indexOut);
  console.log('[build-lite] ✅ index.js 생성 완료');
} else {
  console.warn('[build-lite] ⚠️  scripts/lite-index-template.js 를 찾을 수 없습니다. 건너뜁니다.');
}

// ─── 9. 결과 요약 / Print summary ────────────────────────────────────────
console.log('\n' + '═'.repeat(60));
console.log('[build-lite] 🎉 빌드 완료!');
console.log('─'.repeat(60));
console.log(`  포함된 축 (Axes):      ${include_axes.join(', ')}`);
console.log(`  처리된 모듈 수:        ${totalModulesProcessed}개`);
console.log(`  총 예상 토큰 수:       ${totalEstimatedTokens.toLocaleString()} tokens`);
console.log(`  출력 경로:             ${OUTPUT_ROOT}`);
console.log('  작성된 파일:');
for (const f of writtenFiles) {
  console.log(`    • ${path.relative(ROOT, f)}`);
}
console.log('─'.repeat(60));
console.log('  ℹ️  dist/ 는 .gitignore 에 의해 커밋되지 않습니다.');
console.log('  ℹ️  배포 시 dist/lite/ 폴더 전체를 외부 레포에 복사하세요.');
console.log('═'.repeat(60) + '\n');
