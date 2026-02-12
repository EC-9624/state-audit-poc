import path from "node:path";
import {
  ModuleKind,
  ModuleResolutionKind,
  Project,
  ScriptTarget,
  ts,
  type SourceFile,
} from "ts-morph";
import { isFileInScope, toPosixPath } from "./config";
import type { AnalyzerConfig } from "./types";

export interface LoadedProject {
  project: Project;
  sourceFiles: SourceFile[];
}

export function loadProject(config: AnalyzerConfig): LoadedProject {
  const project = config.tsconfigPath
    ? new Project({
        tsConfigFilePath: config.tsconfigPath,
        skipAddingFilesFromTsConfig: false,
      })
    : new Project({
        compilerOptions: {
          target: ScriptTarget.ES2020,
          module: ModuleKind.CommonJS,
          moduleResolution: ModuleResolutionKind.NodeJs,
          jsx: ts.JsxEmit.ReactJSX,
          esModuleInterop: true,
          skipLibCheck: true,
          allowJs: false,
        },
      });

  const sourcePattern = toPosixPath(path.join(config.rootDir, "**/*.{ts,tsx}"));
  project.addSourceFilesAtPaths(sourcePattern);

  const sourceFiles = project
    .getSourceFiles()
    .filter((sourceFile) => !sourceFile.isDeclarationFile())
    .filter((sourceFile) => isFileInScope(config, sourceFile.getFilePath()))
    .sort((left, right) => left.getFilePath().localeCompare(right.getFilePath()));

  if (sourceFiles.length === 0) {
    throw new Error(`No TS/TSX source files found in scope for root: ${config.rootDir}`);
  }

  return { project, sourceFiles };
}
