/**
 * Controlled Figma fixture generator for the manual Plugin API benchmark.
 *
 * Run this source through the Desktop Bridge's figma_execute in the dedicated
 * empty Benchmark file (see figma-plugin-host.json), or in any other file that
 * still has exactly one page. Edit CONFIG for one tier at a time. The script
 * does not remove existing pages or variables; starting from a one-page empty
 * host keeps the counts reproducible and makes the "freshly opened" flag
 * meaningful. Duplicate the empty host before each tier; do not re-run this
 * generator after pages or variables already exist.
 */
const CONFIG = {
  fixtureVersion: 'ds-fixture-v1',
  variableCount: 100, // 10, 100, 1_000, or 5_000
  pageCount: 5, // 5, 25, or 100
  componentSetsPerPage: 1,
  variantsPerSet: 4,
  instancesPerPage: 2,
  textNodesPerPage: 3,
};

if (!figma || !figma.root) {
  throw new Error('Run this fixture generator inside Figma via figma_execute.');
}
if (figma.root.children.length !== 1) {
  throw new Error('Fixture generation requires a fresh Figma file with exactly one page.');
}
if (![10, 100, 1000, 5000].includes(CONFIG.variableCount)) {
  throw new Error('variableCount must be 10, 100, 1000, or 5000.');
}
if (![5, 25, 100].includes(CONFIG.pageCount)) {
  throw new Error('pageCount must be 5, 25, or 100.');
}

const firstPage = figma.root.children[0];
firstPage.name = 'PERF 01';
const pages = [firstPage];
for (let i = 1; i < CONFIG.pageCount; i++) {
  const page = figma.createPage();
  page.name = 'PERF ' + String(i + 1).padStart(2, '0');
  pages.push(page);
}

const collections = [
  figma.variables.createVariableCollection('Benchmark/Primitives'),
  figma.variables.createVariableCollection('Benchmark/Semantic'),
  figma.variables.createVariableCollection('Benchmark/Spacing'),
  figma.variables.createVariableCollection('Benchmark/Typography'),
];
let darkModeAvailable = true;
for (const collection of collections) {
  collection.renameMode(collection.modes[0].modeId, 'Base');
  try {
    collection.addMode('Dark');
  } catch {
    // Starter/free plans allow only one mode per collection.
    darkModeAvailable = false;
  }
}

const resolvedTypes = ['COLOR', 'FLOAT', 'STRING', 'BOOLEAN'];
function colorFor(index) {
  return {
    r: ((index * 37) % 255) / 255,
    g: ((index * 67 + 40) % 255) / 255,
    b: ((index * 97 + 80) % 255) / 255,
    a: 1,
  };
}

for (let i = 0; i < CONFIG.variableCount; i++) {
  const resolvedType = resolvedTypes[i % resolvedTypes.length];
  const collection = collections[i % collections.length];
  const variable = figma.variables.createVariable(
    'benchmark/' + collection.name.split('/').pop().toLowerCase() + '/' + String(i + 1).padStart(5, '0'),
    collection,
    resolvedType,
  );
  const baseModeId = collection.modes[0].modeId;
  const darkModeId = collection.modes[1] ? collection.modes[1].modeId : null;
  let baseValue;
  let darkValue;
  if (resolvedType === 'COLOR') {
    baseValue = colorFor(i);
    darkValue = colorFor(i + 17);
  } else if (resolvedType === 'FLOAT') {
    baseValue = (i % 32) + 1;
    darkValue = baseValue + 1;
  } else if (resolvedType === 'BOOLEAN') {
    baseValue = i % 2 === 0;
    darkValue = !baseValue;
  } else {
    baseValue = 'benchmark/value/' + (i + 1);
    darkValue = 'benchmark/dark/' + (i + 1);
  }
  variable.setValueForMode(baseModeId, baseValue);
  if (darkModeId) {
    variable.setValueForMode(darkModeId, darkValue);
  }
}

let loadedFonts = [];
for (const font of [
  { family: 'Inter', style: 'Regular' },
  { family: 'Inter', style: 'Bold' },
]) {
  try {
    await figma.loadFontAsync(font);
    loadedFonts.push(font.family + ' ' + font.style);
  } catch {
    // The bridge's font benchmark records unavailable fonts as failed loads.
  }
}

function addText(parent, characters, style, x, y) {
  const text = figma.createText();
  text.fontName = style;
  text.characters = characters;
  text.x = x;
  text.y = y;
  parent.appendChild(text);
  return text;
}

let componentSetCount = 0;
let variantCount = 0;
let instanceCount = 0;
let standaloneCount = 0;
let pageTextCount = 0;

for (let pageIndex = 0; pageIndex < pages.length; pageIndex++) {
  const page = pages[pageIndex];
  await figma.setCurrentPageAsync(page);
  for (let setIndex = 0; setIndex < CONFIG.componentSetsPerPage; setIndex++) {
    const variants = [];
    for (let variantIndex = 0; variantIndex < CONFIG.variantsPerSet; variantIndex++) {
      const component = figma.createComponent();
      component.name = 'State=' + (variantIndex % 2 ? 'hover' : 'default') +
        ', Size=' + (variantIndex >= 2 ? 'large' : 'small');
      component.resizeWithoutConstraints(240, 64);
      page.appendChild(component);
      addText(
        component,
        'Benchmark ' + (variantIndex + 1),
        { family: 'Inter', style: variantIndex % 2 ? 'Bold' : 'Regular' },
        16,
        16,
      );
      variants.push(component);
      variantCount++;
    }
    const set = figma.combineAsVariants(variants, page);
    set.name = 'Benchmark/Button ' + (setIndex + 1);
    set.x = 40 + setIndex * 300;
    set.y = 40;
    componentSetCount++;

    for (let instanceIndex = 0; instanceIndex < CONFIG.instancesPerPage; instanceIndex++) {
      const instance = set.defaultVariant.createInstance();
      instance.x = 40 + instanceIndex * 280;
      instance.y = 180;
      page.appendChild(instance);
      instanceCount++;
    }
  }

  const standalone = figma.createComponent();
  standalone.name = 'Benchmark/Standalone ' + (pageIndex + 1);
  standalone.resizeWithoutConstraints(200, 48);
  page.appendChild(standalone);
  addText(standalone, 'Standalone component', { family: 'Inter', style: 'Regular' }, 12, 12);
  standalone.x = 40;
  standalone.y = 280;
  standaloneCount++;

  for (let textIndex = 0; textIndex < CONFIG.textNodesPerPage; textIndex++) {
    addText(
      page,
      'Performance fixture text ' + (textIndex + 1),
      { family: 'Inter', style: textIndex === 0 ? 'Bold' : 'Regular' },
      40,
      380 + textIndex * 28,
    );
    pageTextCount++;
  }
}

await figma.setCurrentPageAsync(firstPage);

return {
  success: true,
  fixtureVersion: CONFIG.fixtureVersion,
  fileKey: figma.fileKey || null,
  fileName: figma.root && figma.root.name ? figma.root.name : null,
  variableCount: CONFIG.variableCount,
  pageCount: CONFIG.pageCount,
  collectionCount: collections.length,
  componentSetCount,
  variantCount,
  instanceCount,
  standaloneCount,
  pageTextCount,
  loadedFonts,
  activePage: firstPage.name,
  modesPerCollection: darkModeAvailable ? 2 : 1,
  note: darkModeAvailable
    ? 'Keep this file dedicated to the manual benchmark and record whether it was freshly opened before each run.'
    : 'Dark mode omitted because this Figma plan allows only one mode per collection. Keep this file dedicated to the manual benchmark.',
};
