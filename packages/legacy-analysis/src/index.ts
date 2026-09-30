export {
  analyzeRepository,
  type AnalyzeOptions,
  type RepositoryAnalysis,
} from './analyze.js';
export { analyzeJavaFile, cyclomaticOf, type JavaAnnotation, type JavaField, type JavaFile, type JavaFileSignals, type JavaMethod, type JavaTypeDeclaration } from './java.js';
export {
  analyzeSqlFile,
  cleanIdentifier,
  parseColumns,
  splitStatements,
  splitTopLevel,
  type DatabaseColumnInfo,
  type DatabaseObjectInfo,
  type SqlFileAnalysis,
  type SqlStatementInfo,
} from './sql.js';
export { looksLikeSql, sqlSignals, sqlVerbOf, tablesOf, type SqlVerb } from './sql-text.js';
export {
  detectBuildSystems,
  declaredLanguageLevel,
  detectConfiguration,
  detectFrameworks,
  detectMigrations,
} from './build.js';
export {
  extractWebLayer,
  findDuplicateRoutes,
  joinPath,
  literalPaths,
  type ExtractedEndpoint,
  type ExtractedEntryPoint,
  type WebLayerExtraction,
} from './http-endpoints.js';
export {
  buildDependencyMap,
  callChains,
  classIdOf,
  computeHotspots,
  endpointId,
  findCycles,
  type GraphInput,
} from './graph.js';
export { detectDuplication, detectSuspicious, symbolOf, type SuspiciousInput } from './suspicious.js';
export {
  categorize,
  countLines,
  extensionOf,
  walkRepository,
  LANGUAGE_BY_EXTENSION,
  type WalkOptions,
  type WalkResult,
  type WalkedFile,
} from './walk.js';
export {
  lineAt,
  lineOf,
  lineText,
  maskSource,
  matchingBrace,
  matchingParen,
  type MaskedSource,
  type SourceComment,
  type SourceLiteral,
} from './scanner.js';
export { ANALYSIS_GENERATOR, evidenceFor, evidenceId, sourceEvidence, type EvidenceInput } from './evidence.js';
