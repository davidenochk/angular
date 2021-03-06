/**
 * @license
 * Copyright Google Inc. All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {SummaryResolver} from '../summary_resolver';
import {ValueTransformer, visitValue} from '../util';

import {StaticSymbol, StaticSymbolCache} from './static_symbol';

export class ResolvedStaticSymbol {
  constructor(public symbol: StaticSymbol, public metadata: any) {}
}

/**
 * The host of the SymbolResolverHost disconnects the implementation from TypeScript / other
 * language
 * services and from underlying file systems.
 */
export interface StaticSymbolResolverHost {
  /**
   * Return a ModuleMetadata for the given module.
   * Angular 2 CLI will produce this metadata for a module whenever a .d.ts files is
   * produced and the module has exported variables or classes with decorators. Module metadata can
   * also be produced directly from TypeScript sources by using MetadataCollector in tools/metadata.
   *
   * @param modulePath is a string identifier for a module as an absolute path.
   * @returns the metadata for the given module.
   */
  getMetadataFor(modulePath: string): {[key: string]: any}[];

  /**
   * Converts a module name that is used in an `import` to a file path.
   * I.e.
   * `path/to/containingFile.ts` containing `import {...} from 'module-name'`.
   */
  moduleNameToFileName(moduleName: string, containingFile: string): string /*|null*/;
}

const SUPPORTED_SCHEMA_VERSION = 3;

/**
 * This class is responsible for loading metadata per symbol,
 * and normalizing references between symbols.
 */
export class StaticSymbolResolver {
  private metadataCache = new Map<string, {[key: string]: any}>();
  private resolvedSymbols = new Map<StaticSymbol, ResolvedStaticSymbol>();
  private resolvedFilePaths = new Set<string>();

  constructor(
      private host: StaticSymbolResolverHost, private staticSymbolCache: StaticSymbolCache,
      private summaryResolver: SummaryResolver<StaticSymbol>,
      private errorRecorder?: (error: any, fileName: string) => void) {}

  resolveSymbol(staticSymbol: StaticSymbol): ResolvedStaticSymbol {
    if (staticSymbol.members.length > 0) {
      return this._resolveSymbolMembers(staticSymbol);
    }
    let result = this._resolveSymbolFromSummary(staticSymbol);
    if (!result) {
      // Note: Some users use libraries that were not compiled with ngc, i.e. they don't
      // have summaries, only .d.ts files. So we always need to check both, the summary
      // and metadata.
      this._createSymbolsOf(staticSymbol.filePath);
      result = this.resolvedSymbols.get(staticSymbol);
    }
    return result;
  }

  private _resolveSymbolMembers(staticSymbol: StaticSymbol): ResolvedStaticSymbol {
    const members = staticSymbol.members;
    const baseResolvedSymbol =
        this.resolveSymbol(this.getStaticSymbol(staticSymbol.filePath, staticSymbol.name));
    if (!baseResolvedSymbol) {
      return null;
    }
    const baseMetadata = baseResolvedSymbol.metadata;
    if (baseMetadata instanceof StaticSymbol) {
      return new ResolvedStaticSymbol(
          staticSymbol, this.getStaticSymbol(baseMetadata.filePath, baseMetadata.name, members));
    } else if (baseMetadata && baseMetadata.__symbolic === 'class') {
      if (baseMetadata.statics && members.length === 1) {
        return new ResolvedStaticSymbol(staticSymbol, baseMetadata.statics[members[0]]);
      }
    } else {
      let value = baseMetadata;
      for (let i = 0; i < members.length && value; i++) {
        value = value[members[i]];
      }
      return new ResolvedStaticSymbol(staticSymbol, value);
    }
    return null;
  }

  private _resolveSymbolFromSummary(staticSymbol: StaticSymbol): ResolvedStaticSymbol {
    const summary = this.summaryResolver.resolveSummary(staticSymbol);
    return summary ? new ResolvedStaticSymbol(staticSymbol, summary.metadata) : null;
  }

  /**
   * getStaticSymbol produces a Type whose metadata is known but whose implementation is not loaded.
   * All types passed to the StaticResolver should be pseudo-types returned by this method.
   *
   * @param declarationFile the absolute path of the file where the symbol is declared
   * @param name the name of the type.
   */
  getStaticSymbol(declarationFile: string, name: string, members?: string[]): StaticSymbol {
    return this.staticSymbolCache.get(declarationFile, name, members);
  }

  getSymbolsOf(filePath: string): StaticSymbol[] {
    // Note: Some users use libraries that were not compiled with ngc, i.e. they don't
    // have summaries, only .d.ts files. So we always need to check both, the summary
    // and metadata.
    let symbols = new Set<StaticSymbol>(this.summaryResolver.getSymbolsOf(filePath));
    this._createSymbolsOf(filePath);
    this.resolvedSymbols.forEach((resolvedSymbol) => {
      if (resolvedSymbol.symbol.filePath === filePath) {
        symbols.add(resolvedSymbol.symbol);
      }
    });
    return Array.from(symbols);
  }

  private _createSymbolsOf(filePath: string) {
    if (this.resolvedFilePaths.has(filePath)) {
      return;
    }
    this.resolvedFilePaths.add(filePath);
    const resolvedSymbols: ResolvedStaticSymbol[] = [];
    const metadata = this.getModuleMetadata(filePath);
    if (metadata['metadata']) {
      // handle direct declarations of the symbol
      Object.keys(metadata['metadata']).forEach((symbolName) => {
        const symbolMeta = metadata['metadata'][symbolName];
        resolvedSymbols.push(
            this.createResolvedSymbol(this.getStaticSymbol(filePath, symbolName), symbolMeta));
      });
    }

    // handle the symbols in one of the re-export location
    if (metadata['exports']) {
      for (const moduleExport of metadata['exports']) {
        // handle the symbols in the list of explicitly re-exported symbols.
        if (moduleExport.export) {
          moduleExport.export.forEach((exportSymbol: any) => {
            let symbolName: string;
            if (typeof exportSymbol === 'string') {
              symbolName = exportSymbol;
            } else {
              symbolName = exportSymbol.as;
            }
            let symName = symbolName;
            if (typeof exportSymbol !== 'string') {
              symName = exportSymbol.name;
            }
            const resolvedModule = this.resolveModule(moduleExport.from, filePath);
            if (resolvedModule) {
              const targetSymbol = this.getStaticSymbol(resolvedModule, symName);
              const sourceSymbol = this.getStaticSymbol(filePath, symbolName);
              resolvedSymbols.push(new ResolvedStaticSymbol(sourceSymbol, targetSymbol));
            }
          });
        } else {
          // handle the symbols via export * directives.
          const resolvedModule = this.resolveModule(moduleExport.from, filePath);
          if (resolvedModule) {
            const nestedExports = this.getSymbolsOf(resolvedModule);
            nestedExports.forEach((targetSymbol) => {
              const sourceSymbol = this.getStaticSymbol(filePath, targetSymbol.name);
              resolvedSymbols.push(new ResolvedStaticSymbol(sourceSymbol, targetSymbol));
            });
          }
        }
      }
    }
    resolvedSymbols.forEach(
        (resolvedSymbol) => this.resolvedSymbols.set(resolvedSymbol.symbol, resolvedSymbol));
  }

  private createResolvedSymbol(sourceSymbol: StaticSymbol, metadata: any): ResolvedStaticSymbol {
    const self = this;

    class ReferenceTransformer extends ValueTransformer {
      visitStringMap(map: {[key: string]: any}, functionParams: string[]): any {
        const symbolic = map['__symbolic'];
        if (symbolic === 'function') {
          const oldLen = functionParams.length;
          functionParams.push(...(map['parameters'] || []));
          const result = super.visitStringMap(map, functionParams);
          functionParams.length = oldLen;
          return result;
        } else if (symbolic === 'reference') {
          const module = map['module'];
          const name = map['name'];
          if (!name) {
            return null;
          }
          let filePath: string;
          if (module) {
            filePath = self.resolveModule(module, sourceSymbol.filePath);
            if (!filePath) {
              return {
                __symbolic: 'error',
                message: `Could not resolve ${module} relative to ${sourceSymbol.filePath}.`
              };
            }
          } else {
            const isFunctionParam = functionParams.indexOf(name) >= 0;
            if (!isFunctionParam) {
              filePath = sourceSymbol.filePath;
            }
          }
          if (filePath) {
            return self.getStaticSymbol(filePath, name);
          } else {
            // reference to a function parameter
            return {__symbolic: 'reference', name: name};
          }
        } else {
          return super.visitStringMap(map, functionParams);
        }
      }
    }

    const transformedMeta = visitValue(metadata, new ReferenceTransformer(), []);
    return new ResolvedStaticSymbol(sourceSymbol, transformedMeta);
  }

  private reportError(error: Error, context: StaticSymbol, path?: string) {
    if (this.errorRecorder) {
      this.errorRecorder(error, (context && context.filePath) || path);
    } else {
      throw error;
    }
  }

  /**
   * @param module an absolute path to a module file.
   */
  private getModuleMetadata(module: string): {[key: string]: any} {
    let moduleMetadata = this.metadataCache.get(module);
    if (!moduleMetadata) {
      const moduleMetadatas = this.host.getMetadataFor(module);
      if (moduleMetadatas) {
        let maxVersion = -1;
        moduleMetadatas.forEach((md) => {
          if (md['version'] > maxVersion) {
            maxVersion = md['version'];
            moduleMetadata = md;
          }
        });
      }
      if (!moduleMetadata) {
        moduleMetadata =
            {__symbolic: 'module', version: SUPPORTED_SCHEMA_VERSION, module: module, metadata: {}};
      }
      if (moduleMetadata['version'] != SUPPORTED_SCHEMA_VERSION) {
        const errorMessage = moduleMetadata['version'] == 2 ?
            `Unsupported metadata version ${moduleMetadata['version']} for module ${module}. This module should be compiled with a newer version of ngc` :
            `Metadata version mismatch for module ${module}, found version ${moduleMetadata['version']}, expected ${SUPPORTED_SCHEMA_VERSION}`;
        this.reportError(new Error(errorMessage), null);
      }
      this.metadataCache.set(module, moduleMetadata);
    }
    return moduleMetadata;
  }

  getSymbolByModule(module: string, symbolName: string, containingFile?: string): StaticSymbol {
    const filePath = this.resolveModule(module, containingFile);
    if (!filePath) {
      throw new Error(`Could not resolve module ${module} relative to ${containingFile}`);
    }
    return this.getStaticSymbol(filePath, symbolName);
  }

  private resolveModule(module: string, containingFile: string): string {
    try {
      return this.host.moduleNameToFileName(module, containingFile);
    } catch (e) {
      console.error(`Could not resolve module '${module}' relative to file ${containingFile}`);
      this.reportError(new e, null, containingFile);
    }
  }
}
