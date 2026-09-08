#!/usr/bin/env node
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

const OUTPUT_DIR = path.join(process.cwd(), 'manifest');
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'package.xml');
const TARGET_BRANCH = process.env.CI_MERGE_REQUEST_TARGET_BRANCH_NAME;
const PACKAGE_VERSION = '65.0';
const BATCH_SIZE = 200; // Tamaño máximo

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

console.log(`Detecting changes against: ${TARGET_BRANCH}`);

// 1. Obtener archivos modificados
execSync(`git fetch origin ${TARGET_BRANCH}`, { stdio: 'inherit' });

// Evita que git escape caracteres unicode/accentos
execSync('git config core.quotepath false');

const diff = execSync(
  `git diff --name-only --diff-filter=AM origin/${TARGET_BRANCH}...HEAD`,
  { encoding: 'utf8',
    maxBuffer: 50 * 1024 * 1024
  }
).trim();

const changedFiles = diff.split('\n').map(f => f.trim()).filter(Boolean).filter(f => f.startsWith('force-app/'));

if (changedFiles.length === 0) {
  console.error('No changes detected');
  process.exit(1);
}

console.log(`Changed files: ${changedFiles.length}`);

//Metadata manual para evitar que sf añada carpetas enteras
const manualMetadata = new Map();

// 2. Función para determinar qué pasar a sf CLI
function getSourcePath(filepath) {
  const parts = filepath.split('/');
  
  // force-app/main/default/[tipo]/...
  const metadataType = parts[3];

  //Dashboards -> añadir manualmente
  if (metadataType === 'dashboards') {
    const relativePath = parts.slice(4).join('/');

    const cleanName = relativePath
      .replace('.dashboard-meta.xml', '')
      .replace('.dashboard', '');

    if (!manualMetadata.has('Dashboard')) {
      manualMetadata.set('Dashboard', new Set());
    }

    manualMetadata.get('Dashboard').add(cleanName);

    return null;
  }

  // Reports -> añadir manualmente
  if (metadataType === 'reports') {
    const relativePath = parts.slice(4).join('/');

    const cleanName = relativePath
      .replace('.report-meta.xml', '')
      .replace('.report', '');

    if (!manualMetadata.has('Report')) {
      manualMetadata.set('Report', new Set());
    }

    manualMetadata.get('Report').add(cleanName);

    return null;
  }

  // Email -> añadir manualmente
  if (metadataType === 'email') {
    const relativePath = parts.slice(4).join('/');

    const cleanName = relativePath
      .replace('.email-meta.xml', '')
      .replace('.email', '');

    if (!manualMetadata.has('EmailTemplate')) {
      manualMetadata.set('EmailTemplate', new Set());
    }

    manualMetadata.get('EmailTemplate').add(cleanName);

    return null;
  }

  // Custom Labels -> añadir manualmente SOLO las modificadas
  if (metadataType === 'labels') {

    const diffContent = execSync(
      `git diff origin/${TARGET_BRANCH}...HEAD -- "${filepath}"`,
      { encoding: 'utf8', maxBuffer: 1024 * 1024 * 20 }
    );

    if (!manualMetadata.has('CustomLabel')) {
      manualMetadata.set('CustomLabel', new Set());
    }

    const lines = diffContent.split('\n');

    let insideLabelBlock = false;
    let currentLabelName = null;
    let blockChanged = false;

    const commitCurrentBlock = () => {
      if (
        insideLabelBlock &&
        blockChanged &&
        currentLabelName
      ) {
        manualMetadata
          .get('CustomLabel')
          .add(currentLabelName);
      }
    };

    for (const rawLine of lines) {

      const line =
        rawLine.startsWith('+') ||
        rawLine.startsWith('-') ||
        rawLine.startsWith(' ')
          ? rawLine.substring(1)
          : rawLine;

      if (line.includes('<labels>')) {
        insideLabelBlock = true;
        currentLabelName = null;
        blockChanged = false;
      }

      if (!insideLabelBlock) {
        continue;
      }

      const fullNameMatch = line.match(
        /<fullName>(.*?)<\/fullName>/
      );

      if (fullNameMatch) {
        currentLabelName = fullNameMatch[1];
      }

      if (
        rawLine.startsWith('+') &&
        !rawLine.startsWith('+++')
      ) {
        blockChanged = true;
      }

      if (
        rawLine.startsWith('-') &&
        !rawLine.startsWith('---')
      ) {
        blockChanged = true;
      }

      if (line.includes('</labels>')) {

        if (
          blockChanged &&
          currentLabelName
        ) {
          manualMetadata
            .get('CustomLabel')
            .add(currentLabelName);
        }

        insideLabelBlock = false;
        currentLabelName = null;
        blockChanged = false;
      }
    }

    return null;
  }

  // Tipos que tienen sub-componentes (necesitan archivo específico)
  const GRANULAR_TYPES = [
    'objects',           // fields, listViews, recordTypes, etc.
    'applications',      // profileActionOverrides
    'tabs',              // no tiene sub-componentes pero por consistencia
    'territory2Models',  // force-app/main/default/territory2Models/ModelName/territories/TerritoryName.territory2-meta.xml
    'layouts'
  ];

  if (GRANULAR_TYPES.includes(metadataType)) {
    // Para objetos: pasar el archivo específico
    // force-app/main/default/objects/Account/fields/MyField__c.field-meta.xml
    return filepath;
  } else {
    // Para otros tipos: pasar el directorio del componente
    // force-app/main/default/classes/MyClass
    // force-app/main/default/lwc/myComponent
    return parts.slice(0, 5).join('/');
  }
}

// 3. Crear set de paths únicos
const uniquePaths = new Set(
  changedFiles
    .map(f => getSourcePath(f))
    .filter(Boolean)
);

const pathsArray = Array.from(uniquePaths);

console.log(`Unique paths to process: ${pathsArray.length}`);

try {
  //Si solo hay metadata manual
  if (pathsArray.length === 0) {
    mergeManifests([], OUTPUT_FILE);

    console.log(`package.xml generated at ${OUTPUT_FILE}`);
    process.exit(0);
  }

  // 4. INTENTAR PRIMERO GENERAR TODO DE UNA VEZ
  console.log('Attempting to generate manifest in single execution...');
  const sourcePaths = pathsArray.map(p => `"${p.replace(/\$/g, '\\$')}"`).join(' --source-dir ');
  
  try {
    execSync(
      `sf project generate manifest --source-dir ${sourcePaths} --name package --output-dir ${OUTPUT_DIR}`,
      { stdio: 'inherit' }
    );

    //Mergear metadata manual
    mergeManifests([OUTPUT_FILE], OUTPUT_FILE);
    
    console.log(`package.xml generated at ${OUTPUT_FILE}`);
    console.log(`Included ${uniquePaths.size} metadata component(s)`);
    
  } catch (singleExecutionError) {
    // 5. SI FALLA, HACER PROCESAMIENTO POR LOTES
    console.log('\n Single execution failed, falling back to batch processing...');
    console.log(`Processing ${pathsArray.length} paths in batches of ${BATCH_SIZE}...`);
    
    const tempManifests = [];
    
    for (let i = 0; i < pathsArray.length; i += BATCH_SIZE) {
      const batch = pathsArray.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      const totalBatches = Math.ceil(pathsArray.length / BATCH_SIZE);
      const tempName = `temp_batch_${batchNum}`;
      
      console.log(`[${batchNum}/${totalBatches}] Processing ${batch.length} paths...`);
      
      const batchSourcePaths = batch.map(p => `"${p.replace(/\$/g, '\\$')}"`).join(' --source-dir ');
      
      execSync(
        `sf project generate manifest --source-dir ${batchSourcePaths} --name ${tempName} --output-dir ${OUTPUT_DIR}`,
        { stdio: 'pipe' }
      );

      tempManifests.push(path.join(OUTPUT_DIR, `${tempName}.xml`));
    }

    // 6. Combinar manifests
    console.log(`Merging ${tempManifests.length} manifests...`);
    mergeManifests(tempManifests, OUTPUT_FILE);
    
    // Limpiar archivos temporales
    tempManifests.forEach(f => {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    });
    
    console.log(`package.xml generated at ${OUTPUT_FILE} (batch mode)`);
    console.log(`Included ${uniquePaths.size} metadata component(s)`);
  }

} catch (error) {
  console.error('Error generating manifest:', error.message);
  console.error(error.stack);
  process.exit(1);
}

// Función para merge de manifests
function mergeManifests(manifestFiles, outputFile) {
  const allTypes = new Map();

  for (const file of manifestFiles) {

    if (!fs.existsSync(file)) {
      continue;
    }

    const content = fs.readFileSync(file, 'utf8');
    
    // Extraer tipos y miembros
    const typeMatches = content.matchAll(/<types>([\s\S]*?)<\/types>/g);
    
    for (const match of typeMatches) {
      const typeBlock = match[1];
      const nameMatch = typeBlock.match(/<name>(.*?)<\/name>/);
      const memberMatches = [...typeBlock.matchAll(/<members>(.*?)<\/members>/g)];
      
      if (nameMatch) {
        const typeName = nameMatch[1];
        // Evitar desplegar todas las labels
        if (typeName === 'CustomLabels') {
          continue;
        }
        if (!allTypes.has(typeName)) {
          allTypes.set(typeName, new Set());
        }
        
        memberMatches.forEach(m => {
          allTypes.get(typeName).add(m[1]);
        });
      }
    }
  }

  //Añadir metadata manual
  for (const [typeName, members] of manualMetadata.entries()) {

    if (!allTypes.has(typeName)) {
      allTypes.set(typeName, new Set());
    }

    members.forEach(member => {
      allTypes.get(typeName).add(member);
    });
  }

  // Construir XML final
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<Package xmlns="http://soap.sforce.com/2006/04/metadata">\n';
  
  // Ordenar tipos alfabéticamente
  const sortedTypes = Array.from(allTypes.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  
  for (const [typeName, members] of sortedTypes) {
    xml += '    <types>\n';
    // Ordenar miembros alfabéticamente
    const sortedMembers = Array.from(members).sort();
    for (const member of sortedMembers) {
      xml += `        <members>${member}</members>\n`;
    }
    xml += `        <name>${typeName}</name>\n`;
    xml += '    </types>\n';
  }
  
  xml += `    <version>${PACKAGE_VERSION}</version>\n`;
  xml += '</Package>\n';
  
  fs.writeFileSync(outputFile, xml, 'utf8');
}