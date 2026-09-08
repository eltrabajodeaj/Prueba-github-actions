/**
 * generatePackageFromErrors.mjs
 *
 * Parsea el output de errores de un deploy/validate de Salesforce CLI
 * y genera un manifest/retrieve_errors_package.xml listo para hacer retrieve.
 *
 * Uso:
 *   node scripts/generatePackageFromErrors.mjs deploy_output.txt [apiVersion]
 *   cat deploy_output.txt | node scripts/generatePackageFromErrors.mjs
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';

// ---------------------------------------------------------------------------
// Mapeo Type del log de errores -> xmlName del package.xml
// ---------------------------------------------------------------------------
const TYPE_MAP = {
  // Core
  ApexClass:                'ApexClass',
  ApexComponent:            'ApexComponent',
  ApexPage:                 'ApexPage',
  ApexTrigger:              'ApexTrigger',
  AuraDefinitionBundle:     'AuraDefinitionBundle',
  LightningComponentBundle: 'LightningComponentBundle',
  CustomObject:             'CustomObject',
  CustomField:              'CustomField',
  CustomMetadata:           'CustomMetadata',
  CustomLabel:              'CustomLabel',
  CustomLabels:             'CustomLabels',
  CustomApplication:        'CustomApplication',
  CustomTab:                'CustomTab',
  CustomPermission:         'CustomPermission',
  // UI / Layout
  Layout:                   'Layout',
  FlexiPage:                'FlexiPage',
  CompactLayout:            'CompactLayout',
  GlobalValueSet:           'GlobalValueSet',
  StandardValueSet:         'StandardValueSet',
  RecordType:               'RecordType',
  // Security / Access
  Profile:                  'Profile',
  PermissionSet:            'PermissionSet',
  PermissionSetGroup:       'PermissionSetGroup',
  Role:                     'Role',
  Group:                    'Group',
  SharingRules:             'SharingRules',
  SharingCriteriaRule:      'SharingCriteriaRule',
  // Automation
  Flow:                     'Flow',
  FlowDefinition:           'FlowDefinition',
  WorkflowRule:             'WorkflowRule',
  ApprovalProcess:          'ApprovalProcess',
  AssignmentRules:          'AssignmentRules',
  EscalationRules:          'EscalationRules',
  AutoResponseRules:        'AutoResponseRules',
  // Reports & Dashboards
  Report:                   'Report',
  ReportType:               'ReportType',
  Dashboard:                'Dashboard',
  DashboardFolder:          'DashboardFolder',
  ReportFolder:             'ReportFolder',
  // Email
  EmailTemplate:            'EmailTemplate',
  EmailTemplateFolder:      'EmailTemplateFolder',
  // Connected Apps & Auth
  ConnectedApp:             'ConnectedApp',
  AuthProvider:             'AuthProvider',
  NamedCredential:          'NamedCredential',
  // Navigation & Menus
  AppMenu:                  'AppMenu',
  NavigationMenu:           'NavigationMenu',
  // Settings & Org config
  Settings:                 'Settings',
  BusinessProcess:          'BusinessProcess',
  Territory2:               'Territory2',
  Territory2Model:          'Territory2Model',
  Territory2Rule:           'Territory2Rule',
  Territory2Type:           'Territory2Type',
  // Misc
  StaticResource:           'StaticResource',
  Document:                 'Document',
  ContentAsset:             'ContentAsset',
  Translation:              'Translation',
  Translations:             'Translations',
  QuickAction:              'QuickAction',
  HomePageLayout:           'HomePageLayout',
  PathAssistant:            'PathAssistant',
  DuplicateRule:            'DuplicateRule',
  MatchingRules:            'MatchingRules',
  ValidationRule:           'ValidationRule',
  WebLink:                  'WebLink',
};

// ---------------------------------------------------------------------------
// Cuando el error de un componente apunta a otro metadato faltante,
// ignoramos el componente que falla y añadimos el metadato real.
// ---------------------------------------------------------------------------
const REDIRECT_PROBLEM_PATTERNS = [
  // "no CustomField named Account.field1__c found"
  {
    pattern: /no CustomField named ([A-Za-z0-9_.]+) found/i,
    resolve: (m) => ({ xmlName: 'CustomField', member: m[1] }),
  },
  // "no CustomObject named MyObj__c found"
  {
    pattern: /no CustomObject named ([A-Za-z0-9_.]+) found/i,
    resolve: (m) => ({ xmlName: 'CustomObject', member: m[1] }),
  },
  // "no Layout named SomeObject-SomeLayout found"
  {
    pattern: /no Layout named ([^(]+?) found/i,
    resolve: (m) => ({ xmlName: 'Layout', member: m[1].trim() }),
  },
  // "no ConnectedApp named Chatter_Desktop found"
  {
    pattern: /no ConnectedApp named ([A-Za-z0-9_]+) found/i,
    resolve: (m) => ({ xmlName: 'ConnectedApp', member: m[1] }),
  },
  // "no CustomPermission named X found"
  {
    pattern: /no CustomPermission named ([A-Za-z0-9_]+) found/i,
    resolve: (m) => ({ xmlName: 'CustomPermission', member: m[1] }),
  },
  // "no RecordType named X found"
  {
    pattern: /no RecordType named ([^(]+?) found/i,
    resolve: (m) => ({ xmlName: 'RecordType', member: m[1].trim() }),
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function addMember(typesMap, xmlName, member) {
  if (!xmlName || !member) return;
  if (!typesMap.has(xmlName)) typesMap.set(xmlName, new Set());
  typesMap.get(xmlName).add(member);
}

/**
 * Añade una clase con cobertura insuficiente y su clase de test inventada (<Nombre>Test).
 * En el log de consola solo se muestra la clase original; en el package van las dos.
 */
function addCoverageClass(typesMap, coverageLog, className) {
  addMember(typesMap, 'ApexClass', className);
  addMember(typesMap, 'ApexClass', className + 'Test');
  if (!coverageLog.includes(className)) coverageLog.push(className);
}

/**
 * Lee todas las líneas de un stream y devuelve un array de strings.
 */
async function readLines(stream) {
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  const lines = [];
  for await (const line of rl) lines.push(line);
  return lines;
}

/**
 * Genera el XML del package.xml a partir del mapa { xmlName -> Set<memberName> }
 */
function buildPackageXml(typesMap, apiVersion = '62.0') {
  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<Package xmlns="http://soap.sforce.com/2006/04/metadata">',
  ];
  for (const xmlName of [...typesMap.keys()].sort()) {
    const members = [...typesMap.get(xmlName)].sort();
    out.push('    <types>');
    for (const member of members) out.push(`        <members>${member}</members>`);
    out.push(`        <name>${xmlName}</name>`);
    out.push('    </types>');
  }
  out.push(`    <version>${apiVersion}</version>`);
  out.push('</Package>');
  return out.join('\n');
}

/**
 * Parsea una línea de la tabla de errores y devuelve { type, name, problem }.
 * Devuelve null si la línea no es una fila de datos válida.
 */
function parseComponentFailureLine(line) {
  if (!line.trim() || /^[-\s]+$/.test(line)) return null;
  const trimmed = line.trimStart();
  const parts = trimmed.split(/\s{2,}/);
  if (parts.length < 3) return null;
  const type    = parts[0].trim();
  const name    = parts[1].trim();
  const problem = parts.slice(2).join('  ').trim();
  if (type === 'Type' && name === 'Name') return null;
  if (!type || !name) return null;
  return { type, name, problem };
}

/**
 * Parsea una línea de la tabla de Test Failures y devuelve el nombre de la clase.
 * Formato: " ClassName   methodName   Fail   message"
 */
function parseTestFailureLine(line) {
  if (!line.trim() || /^[-\s]+$/.test(line)) return null;
  const trimmed = line.trimStart();
  const parts = trimmed.split(/\s{2,}/);
  if (parts.length < 3) return null;
  const name = parts[0].trim();
  if (name === 'Name') return null;
  return name || null;
}

/**
 * Elimina secuencias de escape ANSI y caracteres de control Unicode
 * que el CLI puede incluir en el output (colores, spinners, etc.)
 */
function stripAnsi(text) {
  return text
    .replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
    .replace(/\x1B./g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * Busca el patron de coverage en cualquier fragmento de texto.
 * Maneja prefijos como "> ", escapes ANSI, espacios arbitrarios.
 * Devuelve array de nombres de clase encontrados.
 */
function extractCoverageFromText(text) {
  const found = [];
  const clean = stripAnsi(text);
  // Patron flexible: cualquier prefijo no alfanumerico antes del nombre
  const re = /(?:^|[^A-Za-z0-9_])([A-Za-z0-9_]+)\s*-\s*Test coverage of selected Apex Class/gi;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const className = m[1].trim();
    if (className && !found.includes(className)) found.push(className);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const inputFile  = args[0];
  const apiVersion = args[1] ?? '62.0';

  let lines;
  if (inputFile) {
    if (!fs.existsSync(inputFile)) {
      console.error('No se encontro el fichero: ' + inputFile);
      process.exit(1);
    }
    lines = await readLines(fs.createReadStream(inputFile));
  } else {
    if (process.stdin.isTTY) {
      console.error('Uso: node scripts/generatePackageFromErrors.mjs [deploy_output.txt] [apiVersion]');
      process.exit(1);
    }
    lines = await readLines(process.stdin);
  }

  // Unir todo el contenido en un string y luego re-dividir por separadores
  // conocidos para manejar tanto saltos de linea reales como texto comprimido
  const fullText = lines.join('\n');

  const typesMap    = new Map();
  const unknownTypes = new Set();
  const redirectLog  = [];
  const coverageLog  = [];

  // --- PASO 1: buscar coverage en TODO el texto (cubre el formato inline
  //             FailedValidationError tanto en lineas separadas como en una sola)
  for (const className of extractCoverageFromText(fullText)) {
    addCoverageClass(typesMap, coverageLog, className);
  }

  // --- PASO 2: parsear bloques Component Failures y Test Failures linea a linea
  let section = null;

  for (const line of lines) {
    if (/Component Failures/i.test(line)) { section = 'component'; continue; }
    if (/Test Failures/i.test(line))      { section = 'test';      continue; }
    if (/^(Tests Ran|Deploy ID|Status:|Elapsed)/i.test(line.trim())) {
      section = null;
      continue;
    }

    if (section === 'component') {
      const parsed = parseComponentFailureLine(line);
      if (!parsed) continue;
      const { type, name, problem } = parsed;

      // Redirigir si el problema apunta a otro metadato
      let redirected = false;
      for (const { pattern, resolve } of REDIRECT_PROBLEM_PATTERNS) {
        const m = problem.match(pattern);
        if (m) {
          const { xmlName, member } = resolve(m);
          addMember(typesMap, xmlName, member);
          redirectLog.push({ from: `${type}/${name}`, to: `${xmlName}/${member}` });
          redirected = true;
          break;
        }
      }
      if (redirected) continue;

      // Coverage dentro de Component Failures
      if (/test coverage.*at least 75%/i.test(problem)) {
        addCoverageClass(typesMap, coverageLog, name);
        continue;
      }

      // Componente con error directo
      const xmlName = TYPE_MAP[type];
      if (!xmlName) {
        unknownTypes.add(type);
        addMember(typesMap, type, name);
      } else {
        addMember(typesMap, xmlName, name);
      }
      continue;
    }

    // ── Bloque Test Failures ────────────────────────────────────────────────
    if (section === 'test') {
      const className = parseTestFailureLine(line);
      if (!className) continue;

      // Solo nos interesan líneas de cobertura insuficiente
      if (/test coverage.*at least 75%/i.test(line)) {
        addCoverageClass(typesMap, coverageLog, className);
      }
      continue;
    }
  }

  // --- Escribir package.xml
  const outDir  = 'manifest';
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, 'retrieve_errors_package.xml');
  fs.writeFileSync(outPath, buildPackageXml(typesMap, apiVersion), 'utf8');

  // --- Resumen
  console.log('\nPackage generado: ' + outPath);
  console.log('-'.repeat(60));

  if (typesMap.size === 0) {
    console.warn('No se encontraron componentes con errores en el input.');
    console.warn('Asegurate de que el output contiene "Component Failures", "Test Failures" o errores de coverage.');
  } else {
    let total = 0;
    for (const [xmlName, members] of [...typesMap.entries()].sort()) {
      console.log('  ' + xmlName.padEnd(35) + '(' + members.size + ' miembro' + (members.size !== 1 ? 's' : '') + ')');
      total += members.size;
    }
    console.log('-'.repeat(60));
    console.log('  Total: ' + typesMap.size + ' tipo' + (typesMap.size !== 1 ? 's' : '') + ', ' + total + ' miembros');
  }

  if (redirectLog.length > 0) {
    console.log('\nDependencias:');
    for (const r of redirectLog) console.log('  ' + r.from.padEnd(45) + ' -> ' + r.to);
  }

  if (coverageLog.length > 0) {
    console.log('\nClases con cobertura insuficiente:');
    for (const c of coverageLog) console.log('  - ' + c);
    console.log('  (Se ha añadido también <Clase>Test al package para el retrieve)\n');
  }

  if (unknownTypes.size > 0) {
    console.warn('\nTipos no encontrados en TYPE_MAP (incluidos con el type original):');
    for (const t of unknownTypes) console.warn('  - ' + t);
  }
}

main().catch(err => {
  console.error('Error inesperado: ' + err);
  process.exit(1);
});
