// Monaco's pinned ESM build exposes these internals without declarations.
declare module "monaco-editor/base/browser/ui/aria/aria.js" {
  export function alert(message: string): void;
}

declare module "monaco-editor/editor/common/services/languageFeatures.js" {
  export const ILanguageFeaturesService: { readonly type: { signatureHelpProvider: unknown } };
}

declare module "monaco-editor/editor/standalone/browser/standaloneServices.js" {
  export const StandaloneServices: {
    get<T>(identifier: { readonly type: T }): T;
  };
}

declare module "monaco-editor/editor/contrib/parameterHints/browser/parameterHintsModel.js" {
  import type { IDisposable, editor, languages } from "monaco-editor/editor/editor.api.js";

  export class ParameterHintsModel implements IDisposable {
    constructor(code: editor.IStandaloneCodeEditor, providers: unknown);
    onChangedHints(listener: (hints: languages.SignatureHelp | undefined) => void): IDisposable;
    trigger(context: Pick<languages.SignatureHelpContext, "triggerKind">, delay?: number): void;
    cancel(): void;
    dispose(): void;
  }
}

declare module "monaco-editor/platform/markdown/browser/markdownRenderer.js" {
  import type { IDisposable, IMarkdownString, editor } from "monaco-editor/editor/editor.api.js";

  export const IMarkdownRendererService: {
    readonly type: {
      render(markdown: IMarkdownString, options: {
        context: editor.IStandaloneCodeEditor;
        asyncRenderCallback: () => void;
      }): IDisposable & { element: HTMLElement };
    };
  };
}
