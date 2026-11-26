export type JavaSourceKind = "source" | "test-source" | "resources" | "test-resources";
export type JavaFileKind = "class" | "abstract-class" | "interface" | "enum" | "annotation" | "record";
export type EditorDirectoryKind = "folder" | "package" | JavaSourceKind;

export interface JavaSourceFolder {
  directory: string;
  kind: JavaSourceKind;
}

export interface EditorTreeEntry {
  name: string;
  file: string;
  directory: boolean;
  directoryKind?: EditorDirectoryKind;
  javaKind?: JavaFileKind;
}
