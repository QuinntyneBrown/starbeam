import swc from "@swc/core";
import { createHash } from "crypto";
import searchGlob from "fast-glob";
import * as fs from "fs/promises";
import * as path from "path";
import { isAbsolute } from "path";
import { PromiseReadable } from "promise-readable";
import sh from "shell-escape-tag";
import shell from "shelljs";
import * as util from "util";

export const INSPECT = Symbol.for("nodejs.util.inspect.custom");

export class Workspace {
  /**
   * @param root the root of the workspace, as an absolute directory
   */
  static async create(root: string, namespace: string) {
    let paths = await workspacePackages(root, namespace);

    let packages = await Promise.all(
      paths.map(async (packageRoot) => {
        let manifest = path.resolve(packageRoot, "package.json");
        let buf = await fs.readFile(manifest, { encoding: "utf8" });
        let json: JsonObject = JSON.parse(buf);

        let root = path.dirname(manifest);
        let name = path.basename(root);

        return Package.create(() => workspace, name, json);
      })
    );

    const workspace: Workspace = new Workspace(root, namespace, packages);
    return workspace;
  }

  /**
   * The npm namespace (e.g. the #namespace of `@starbeam/core` is `@starbeam`)
   */
  readonly #namespace: string;
  /**
   * The root of the workspace, as an absolute directory
   */
  readonly #root: string;

  #packages: readonly Package[];

  private constructor(
    root: string,
    namespace: string,
    packages: readonly Package[]
  ) {
    this.#root = root;
    this.#namespace = namespace;
    this.#packages = packages;
  }

  get root(): string {
    return this.#root;
  }

  get packages(): readonly Package[] {
    return this.#packages;
  }

  get namespace(): string {
    return this.#namespace;
  }
}

type JsonValue = string | number | boolean | null | JsonArray | JsonObject;
type JsonArray = readonly JsonValue[];
type JsonObject = { [P in string]: JsonValue };

class Package {
  static create(
    workspace: () => Workspace,
    name: string,
    manifest: JsonObject
  ): Package {
    return new Package(workspace, name, manifest);
  }

  /**
   * The workspace that this package belongs to. It's a thunk because workspaces
   * and packages are cyclic and have to be initialized together.
   */
  readonly #workspaceThunk: () => Workspace;

  /**
   * The name of the package. For example, `#name` of `@starbeam/core` is `core`
   */
  readonly #localName: string;

  /**
   * The parsed package.json
   */
  readonly #manifest: JsonObject;

  private constructor(
    workspace: () => Workspace,
    name: string,
    manifest: JsonObject
  ) {
    this.#workspaceThunk = workspace;
    this.#localName = name;
    this.#manifest = manifest;
  }

  get #workspace(): Workspace {
    return this.#workspaceThunk();
  }

  get name(): string {
    return `${this.#workspace.namespace}/${this.#localName}`;
  }

  /**
   * The root of this package, which contains the package.json
   */
  get root(): AbsolutePath {
    return AbsolutePath.directory(
      path.resolve(
        this.#workspace.root,
        this.#workspace.namespace,
        this.#localName
      )
    );
  }

  get packageJSON(): string {
    return path.resolve(this.#workspace.root);
  }

  async compile({ dryRun }: { dryRun: boolean } = { dryRun: false }) {
    let transpilation = await this.#packageTranspilation();
    let prepare = transpilation.prepare(await this.#getDistFiles());

    prepare.run({ dryRun });

    transpilation.transpile({ dryRun });
  }

  get #dist(): AbsolutePath {
    return this.root.directory("dist");
  }

  get #files(): Promise<AbsolutePaths> {
    return AbsolutePaths.glob(
      [`!(node_modules|dist)**/*.ts`, `index.ts`],
      this.root
    );
  }

  async #packageTranspilation(): Promise<Transpilation> {
    let files = await this.#files;

    let dts = files.filter((file) => file.hasExactExtension("d.ts"));

    for (let file of dts) {
      console.warn(`Unexpected .d.ts file found during compilation (${file})`);
    }

    let ts = files.filter((file) => file.hasExactExtension("ts"));

    log.silent.inspect.labeled(`[TS-FILES]`, ts);

    return Transpilation.create(
      this.name,
      this.#dist,
      ts.mapArray((file) => this.#fileTranspilation(file))
    );
  }

  async #getDistFiles(): Promise<AbsolutePaths> {
    return this.#dist.glob("**", { kind: "all" });
  }

  #fileTranspilation(inputPath: AbsolutePath): TranspileTask {
    let relativePath = inputPath.relativeFromAncestor(this.root);

    let output = this.#dist.file(relativePath).changeExtension("js");
    let digest = output.changeExtension("digest");

    log.silent.inspect.labeled(`[TRANSPILE]`, {
      input: inputPath,
      root: this.root,
      relative: relativePath,
      output,
      digest,
    });

    return TranspileTask.create(inputPath, output, digest);
  }
}

class Transpilation {
  static create(
    name: string,
    dist: AbsolutePath,
    tasks: readonly TranspileTask[]
  ) {
    return new Transpilation(name, dist, tasks);
  }

  readonly #name: string;
  readonly #dist: AbsolutePath;
  readonly #tasks: readonly TranspileTask[];

  private constructor(
    name: string,
    dist: AbsolutePath,
    tasks: readonly TranspileTask[]
  ) {
    this.#name = name;
    this.#dist = dist;
    this.#tasks = tasks;
  }

  prepare(existing: AbsolutePaths): PrepareTranspilation {
    // console.log({ existing, outputPaths: this.outputPaths });

    let digests = existing.filter((file) => file.hasExactExtension("digest"));
    let nonDigests = existing.filter(
      (file) => !file.hasExactExtension("digest")
    );

    return PrepareTranspilation.create(
      this.#name,
      nonDigests.diffByKind(this.outputPaths),
      digests.diff(this.digests)
    );
  }

  async transpile({ dryRun }: { dryRun: boolean } = { dryRun: false }) {
    for (let task of this.#tasks) {
      log.silent.heading(`[TRANSPILING]`, this.#name);

      if (!dryRun) {
        task.transpile();
      }
    }
  }

  get outputFiles(): AbsolutePaths {
    return AbsolutePaths.from(this.#tasks.map((task) => task.output));
  }

  get digests(): AbsolutePaths {
    return this.outputFiles.map((file) => file.changeExtension("digest"));
  }

  get outputPaths(): AbsolutePaths {
    let files = this.outputFiles;
    log.silent.inspect.labeled("[OUT-FILES]", files);
    let directories = files.directory.without(this.#dist);
    log.silent.inspect.labeled("[OUT-DIRS]", files.directory);

    return files.merge(directories);
  }
}

abstract class Mappable<Single, Multiple> {
  abstract map(mapper: (path: Single) => Single | null): Multiple;

  abstract flatMap(
    mapper: (path: Single) => readonly Single[] | Multiple | Single
  ): Multiple;

  abstract find(finder: (path: Single) => boolean): Single | void;

  abstract reduce<U>(
    mapper: (build: U, path: Single) => void,
    build: U,
    strategy: "mutate"
  ): U;
  abstract reduce<U>(
    mapper: (accumulator: U, path: Single) => void,
    initial: U,
    strategy?: "functional"
  ): U;

  filter(filter: (item: Single) => boolean): Multiple {
    return this.map((single) => (filter(single) ? single : null));
  }

  mapArray<U>(mapper: (item: Single) => U): readonly U[] {
    return this.reduce(
      (array: U[], item) => array.push(mapper(item)),
      [],
      "mutate"
    );
  }
}

interface PathDiff {
  readonly added: AbsolutePaths;
  readonly removed: AbsolutePaths;
}

interface PathDiffByKind {
  readonly files: PathDiff;
  readonly directories: PathDiff;
}

class AbsolutePaths
  extends Mappable<AbsolutePath, AbsolutePaths>
  implements Iterable<AbsolutePath>
{
  static empty(): AbsolutePaths {
    return new AbsolutePaths(new Map());
  }

  static from(
    paths: AbsolutePath | AbsolutePaths | AbsolutePath[]
  ): AbsolutePaths {
    if (paths instanceof AbsolutePaths) {
      return paths;
    } else {
      let newPaths = AbsolutePaths.empty();
      newPaths.add(paths);
      return newPaths;
    }
  }

  static async all(
    inside: AbsolutePath,
    options: { kind: FileKind | "all" } = { kind: "regular" }
  ): Promise<AbsolutePaths> {
    return AbsolutePaths.glob("**", inside, options);
  }

  static async glob(
    glob: string | string[],
    inside: AbsolutePath,
    { kind }: { kind: FileKind | "all" } = {
      kind: "regular",
    }
  ) {
    let globs = typeof glob === "string" ? [glob] : glob;
    let fullGlob = globs.map((glob) =>
      path.resolve(AbsolutePath.getFilename(inside), glob)
    );
    return AbsolutePaths.#glob(fullGlob, kind);
  }

  static async #glob(
    globs: string[],
    kind: FileKind | "all"
  ): Promise<AbsolutePaths> {
    switch (kind) {
      case "directory": {
        return AbsolutePaths.marked(
          await searchGlob(globs, {
            markDirectories: true,
            onlyDirectories: true,
          })
        );
      }

      case "regular": {
        return AbsolutePaths.marked(
          await searchGlob(globs, {
            onlyFiles: true,
          })
        );
      }

      case "all": {
        return AbsolutePaths.marked(
          await searchGlob(globs, {
            onlyFiles: false,
            onlyDirectories: false,
            markDirectories: true,
          })
        );
      }

      default: {
        exhaustive(kind, "kind");
      }
    }
  }

  static marked(paths: Iterable<string>): AbsolutePaths {
    let set = AbsolutePaths.empty();
    set.add([...paths].map(AbsolutePath.marked));
    return set;
  }

  #paths: Map<string, AbsolutePath>;

  constructor(paths: Map<string, AbsolutePath>) {
    super();
    this.#paths = paths;
  }

  clone(): AbsolutePaths {
    return new AbsolutePaths(new Map(this.#paths));
  }

  get size(): number {
    return this.#paths.size;
  }

  get regularFiles(): AbsolutePaths {
    return this.map((path) => (path.isRegularFile ? path : null));
  }

  get directories(): AbsolutePaths {
    return this.map((path) => (path.isDirectory ? path : null));
  }

  /**
   * Map each path in this set:
   *
   * - if it's a directory, leave it alone
   * - if it's a regular file, get the file's directory
   */
  get directory(): AbsolutePaths {
    return this.map((path) => (path.isDirectory ? path : path.parent));
  }

  without(paths: AbsolutePath | AbsolutePaths | AbsolutePath[]) {
    let remove = AbsolutePaths.from(paths);
    let filtered = new Map(
      [...this.#paths].filter(([, path]) => !remove.has(path))
    );

    return new AbsolutePaths(filtered);
  }

  /**
   * Returns true if any of the files in this set are directories that contain this path
   */
  contains(maybeChild: AbsolutePath): boolean {
    return !!this.find((path) => path.contains(maybeChild));
  }

  diff(other: AbsolutePaths): { added: AbsolutePaths; removed: AbsolutePaths } {
    let { added, removed } = diffFiles(this, other);

    return {
      added,
      removed,
    };
  }

  /**
   * This method diffs files and directories, but excludes any removed files
   * that are descendents of a removed directory.
   */
  diffByKind(other: AbsolutePaths): PathDiffByKind {
    // console.log({ current: this.directories, next: other.directories });

    let directories = this.directories.diff(other.directories);

    log.silent
      .newline()
      .heading("Directories")
      .newline()
      .inspect.labeled("[LHS]", this.directories)
      .newline()
      .inspect.labeled("[RHS]", other.directories)
      .newline()
      .inspect.labeled("[DIFF]", directories);

    let collapsedDirectories = directories.removed.collapsedDirectories();

    log.silent.newline().inspect.labeled("[CLPS]", collapsedDirectories);

    let files = this.regularFiles.diff(other.regularFiles);

    return {
      files: {
        added: files.added,
        removed: files.removed.removeDescendentsOf(collapsedDirectories),
      },
      directories: {
        added: directories.added,
        removed: collapsedDirectories,
      },
    };
  }

  /**
   * Collapse any child directories into their parents.
   */
  collapsedDirectories(): AbsolutePaths {
    let collapsed = AbsolutePaths.empty();

    for (let { path, rest } of this.#drain()) {
      // console.log({ path, rest });
      if (path.isRegularFile || !rest.contains(path)) {
        collapsed.add(path);
      }
    }

    this.#paths = collapsed.#paths;
    return collapsed;
  }

  removeDescendentsOf(ancestors: AbsolutePaths): AbsolutePaths {
    return this.map((path) => (ancestors.contains(path) ? null : path));
  }

  merge(
    paths: AbsolutePath | AbsolutePaths | readonly AbsolutePath[]
  ): AbsolutePaths {
    let cloned = this.clone();
    cloned.add(paths);
    return cloned;
  }

  add(paths: AbsolutePath | AbsolutePaths | readonly AbsolutePath[]): void {
    if (isArray(paths)) {
      for (let path of paths) {
        this.#add(path);
      }
    } else if (paths instanceof AbsolutePaths) {
      for (let path of paths) {
        this.#add(path);
      }
    } else {
      this.#add(paths);
    }
  }

  #add(...paths: readonly AbsolutePath[]): void {
    for (let path of paths) {
      let filename = AbsolutePath.getFilename(path);

      if (!this.#paths.has(filename)) {
        this.#paths.set(filename, path);
      }
    }
  }

  remove(paths: AbsolutePaths | AbsolutePath) {
    let thisPaths = this.#paths;

    if (paths instanceof AbsolutePath) {
      let filename = AbsolutePath.getFilename(paths);
      thisPaths.delete(filename);
    } else {
      for (let filename of paths.#paths.keys()) {
        thisPaths.delete(filename);
      }
    }
  }

  has(path: AbsolutePath): boolean {
    return this.#paths.has(AbsolutePath.getFilename(path));
  }

  reduce<U>(
    mapper: (build: U, path: AbsolutePath) => void,
    build: U,
    strategy: "mutate"
  ): U;
  reduce<U>(
    mapper: (accumulator: U, path: AbsolutePath) => void,
    initial: U,
    strategy?: "functional"
  ): U;
  reduce<U>(
    mapper: (build: U, path: AbsolutePath) => U | void,
    initial: U,
    strategy: "functional" | "mutate" = "functional"
  ): U {
    if (strategy === "mutate") {
      for (let path of this) {
        mapper(initial, path);
      }

      return initial;
    } else {
      let accumulator = initial;

      for (let path of this) {
        accumulator = mapper(accumulator, path) as U;
      }

      return accumulator;
    }
  }

  map(mapper: (path: AbsolutePath) => AbsolutePath | null): AbsolutePaths {
    let paths = AbsolutePaths.empty();

    for (let path of this.#paths.values()) {
      let mappedPath = mapper(path);

      if (mappedPath) {
        paths.add(mappedPath);
      }
    }

    return paths;
  }

  flatMap(
    mapper: (
      path: AbsolutePath
    ) => readonly AbsolutePath[] | AbsolutePaths | AbsolutePath
  ): AbsolutePaths {
    let paths = AbsolutePaths.empty();

    for (let path of this.#paths.values()) {
      paths.add(mapper(path));
    }

    return paths;
  }

  find(finder: (path: AbsolutePath) => boolean): AbsolutePath | void {
    for (let path of this.#paths.values()) {
      let found = finder(path);

      if (found) {
        return path;
      }
    }
  }

  get #sorted(): Map<string, AbsolutePath> {
    let entries = [...this.#paths.entries()].sort(
      ([a], [b]) => b.length - a.length
    );
    return new Map(entries);
  }

  /**
   * Iterate the paths in this set. Larger paths come first.
   */
  *#drain(): IterableIterator<{ path: AbsolutePath; rest: AbsolutePaths }> {
    let rest = this.#sorted.entries();
    let next = rest.next();

    while (!next.done) {
      let [, path] = next.value;
      let restPaths = new AbsolutePaths(new Map(rest));

      yield { path, rest: restPaths };

      rest = restPaths.#paths.entries();
      next = rest.next();
    }
  }

  *[Symbol.iterator]() {
    for (let path of this.#sorted.values()) {
      yield path;
    }
  }

  [INSPECT]() {
    return [...this];
  }
}

function diffFiles(prev: AbsolutePaths, next: AbsolutePaths) {
  let added = AbsolutePaths.empty();
  let removed = AbsolutePaths.empty();

  for (let path of next) {
    if (!prev.has(path)) {
      added.add(path);
    }
  }

  for (let path of prev) {
    if (!next.has(path)) {
      removed.add(path);
    }
  }

  return { added, removed };
}

function isArray<T extends unknown[] | readonly unknown[]>(
  value: unknown | T
): value is T {
  return Array.isArray(value);
}

function isRoot(p: string): boolean {
  return path.parse(p).root === p;
}

type FileKind = "regular" | "directory";
type SearchKind = FileKind | "all";
type AbsolutePathKind = FileKind | "root";
type IntoAbsolutePath =
  | AbsolutePath
  | FileParts
  | [kind: AbsolutePathKind | "marked", filename: string];

interface Search {
  kind: SearchKind;
}

class AbsolutePath {
  static file(path: string): AbsolutePath {
    return AbsolutePath.#checked(path, "regular", ".file");
  }

  static from(intoPath: IntoAbsolutePath): AbsolutePath {
    if (isArray(intoPath)) {
      let [kind, filename] = intoPath;

      switch (kind) {
        case "root":
        case "directory":
          return AbsolutePath.directory(filename);
        case "marked":
          return AbsolutePath.marked(filename);
        case "regular":
          return AbsolutePath.file(filename);

        default:
          exhaustive(kind, "kind");
      }
    } else if (intoPath instanceof AbsolutePath) {
      return intoPath;
    } else {
      let {
        parent,
        basename: { file, ext },
        kind,
      } = intoPath;

      if (parent) {
        if (ext) {
          let filename = path.resolve(parent, `${file}.${ext}`);
          return AbsolutePath.#checked(filename, kind ?? "regular", ".from");
        } else {
          let filename = path.resolve(parent, file);
          return AbsolutePath.#checked(filename, kind ?? "regular", ".from");
        }
      } else {
        // no parent means the file represents the root
        if (typeof kind === "string" && kind !== "root") {
          throw Error(
            `BUG: getParts() produced { parent: null, kind: not 'root' } (invariant check)`
          );
        }

        return AbsolutePath.#checked(file, "root", ".from");
      }
    }
  }

  static directory(directory: string): AbsolutePath {
    if (isRoot(directory)) {
      return AbsolutePath.#checked(directory, "root", ".directory");
    } else {
      return AbsolutePath.#checked(directory, "directory", ".directory");
    }
  }

  static marked(path: string): AbsolutePath {
    if (isRoot(path)) {
      return AbsolutePath.#checked(path, "root", ".marked");
    } else if (path.endsWith("/")) {
      return AbsolutePath.#checked(path.slice(0, -1), "directory", ".marked");
    } else {
      return AbsolutePath.#checked(path, "regular", ".marked");
    }
  }

  static #checked(
    filename: string,
    kind: "root" | "directory" | "regular",
    fromStaticMethod: string
  ): AbsolutePath {
    if (isAbsolute(filename)) {
      return new AbsolutePath(kind, filename);
    } else {
      throw Error(
        `Unexpected relative path passed to AbsolutePath${fromStaticMethod} (${path})`
      );
    }
  }

  static getFilename(path: AbsolutePath): string {
    return path.#filename;
  }

  // A directory ends with `/`, while a file does not
  readonly #kind: "regular" | "directory" | "root";
  readonly #filename: string;

  private constructor(
    kind: "regular" | "directory" | "root",
    filename: string
  ) {
    this.#kind = kind;
    this.#filename = filename;
  }

  get isRoot(): boolean {
    return this.#kind === "root";
  }

  get isDirectory(): boolean {
    return this.#kind === "directory" || this.#kind === "root";
  }

  get isRegularFile(): boolean {
    return this.#kind === "regular";
  }

  /**
   * Get the parent directory of this AbsolutePath. If this path represents a
   * file system root, `parent` returns null.
   */
  get parent(): AbsolutePath | null {
    // Avoid infinite recursion at the root (`/` or `C:\`, etc.)
    if (this.isRoot) {
      return null;
    } else {
      return AbsolutePath.directory(path.dirname(this.#filename));
    }
  }

  get basename(): { file: string; ext: string | null } {
    return getParts(this.#filename).basename;
  }

  get extension(): string | null {
    return this.basename.ext;
  }

  async read(): Promise<string | null> {
    if (this.#kind !== "regular") {
      throw Error(
        `You can only read from a regular file (file=${this.#filename})`
      );
    }

    try {
      return await fs.readFile(this.#filename, { encoding: "utf-8" });
    } catch (e) {
      return null;
    }
  }

  async digest(): Promise<string | null> {
    let contents = await this.read();
    return contents === null ? null : digest(contents);
  }

  /**
   * Returns true if the specified extension is at the end of the filename. This
   * means that `index.d.ts` has the extension `d.ts` *and* `ts`.
   *
   * See hasExactExtension if you want `d.ts` to match, but not `ts`
   */
  hasExtension<S extends `.${string}`>(
    extension: S
  ): `The extension passed to hasExtension should not have a leading '.'`;
  hasExtension(extension: string): boolean;
  hasExtension(extension: string): unknown {
    if (extension.startsWith(".")) {
      throw Error(
        `The extension passed to hasExtension should not have a leading '.'`
      );
    }

    let {
      basename: { ext },
    } = getParts(this.#filename);

    return ext === extension;
  }

  changeExtension<S extends `.${string}`>(
    extension: S
  ): `The extension passed to hasExtension should not have a leading '.'`;
  changeExtension(extension: string): AbsolutePath;
  changeExtension(extension: string): unknown {
    let {
      parent,
      basename: { file },
    } = getParts(this.#filename);

    let renamed = `${file}.${extension}`;

    if (parent) {
      return AbsolutePath.file(path.resolve(parent, renamed));
    } else {
      return AbsolutePath.file(renamed);
    }
  }

  /**
   * Returns true if the file matches the exact extension. This means that
   * `index.d.ts` has the exact extension `d.ts` but *not* `ts`.
   */
  hasExactExtension<S extends `.${string}`>(
    extension: S
  ): `The extension passed to hasExtension should not have a leading '.'`;
  hasExactExtension(extension: string): boolean;
  hasExactExtension(extension: string): unknown {
    if (extension.startsWith(".")) {
      throw Error(
        `The extension passed to hasExtension should not have a leading '.'`
      );
    }

    let {
      basename: { ext },
    } = getParts(this.#filename);

    return ext === extension;
  }

  async glob(search: Search): Promise<AbsolutePaths>;
  async glob(glob: string, search?: Search): Promise<AbsolutePaths>;
  async glob(): Promise<AbsolutePaths>;
  async glob(
    ...args: [search: Search] | [glob: string, search?: Search] | []
  ): Promise<AbsolutePaths> {
    let glob: string | undefined = undefined;
    let search: Search | undefined = undefined;

    if (args.length !== 0) {
      if (typeof args[0] === "string") {
        [glob, search] = args;
      } else {
        [search] = args;
      }
    }

    if (this.#kind === "regular") {
      throw Error(
        `You cannot execute a glob inside a regular file (file=${
          this.#filename
        }, glob=${glob}, search=${search?.kind ?? "regular"})`
      );
    }

    return AbsolutePaths.glob(glob ?? "**", this, search);
  }

  file(...relativePath: readonly string[]): AbsolutePath {
    if (this.#kind === "regular") {
      throw Error(
        `Cannot create a nested file inside a regular file (parent=${
          this.#filename
        }, child=${path.join(...relativePath)})`
      );
    }

    log.silent.inspect.labeled(`[FILE]`, {
      resolved: path.resolve(this.#filename, ...relativePath),
      path: AbsolutePath.file(path.resolve(this.#filename, ...relativePath)),
    });

    return AbsolutePath.file(path.resolve(this.#filename, ...relativePath));
  }

  directory(...relativePath: readonly string[]): AbsolutePath {
    if (this.#kind === "regular") {
      throw Error(
        `Cannot create a nested directory inside a regular file (parent=${
          this.#filename
        }, child=${path.join(...relativePath)})`
      );
    }

    return AbsolutePath.directory(
      path.resolve(this.#filename, ...relativePath)
    );
  }

  relativeFromAncestor(ancestor: AbsolutePath) {
    if (!ancestor.contains(this)) {
      throw Error(
        `Cannot compute a relative path from ${ancestor.#filename} to ${
          this.#filename
        }, because it is not an ancestor`
      );
    }

    return path.relative(ancestor.#filename, this.#filename);
  }

  contains(maybeChild: AbsolutePath): boolean {
    let relative = path.relative(this.#filename, maybeChild.#filename);

    return !relative.startsWith(".");
  }

  eq(other: AbsolutePath) {
    return this.#filename === other.#filename;
  }

  [INSPECT](context: null, { stylize }: util.InspectOptionsStylized) {
    return `${stylize("Path", "special")}(${stylize(
      this.#filename,
      "module"
    )})`;
  }
}

class PrepareTranspilation {
  static create(
    name: string,
    diff: PathDiffByKind,
    digests: PathDiff
  ): PrepareTranspilation {
    return new PrepareTranspilation(name, diff, digests);
  }

  readonly #name: string;
  readonly #diff: PathDiffByKind;
  readonly #digests: PathDiff;

  private constructor(name: string, diff: PathDiffByKind, digests: PathDiff) {
    this.#name = name;
    this.#diff = diff;
    this.#digests = digests;
  }

  async run({ dryRun }: { dryRun: boolean } = { dryRun: false }) {
    let { directories, files } = this.#diff;

    if (dryRun) {
      log
        .newline()
        .log("[DRY-RUN]", this.#name)
        .newline()
        .heading("[DRY-RUN]", "Directories");

      for (let removed of directories.removed) {
        log.inspect.labeled("  [--]", removed);
      }

      for (let added of directories.added) {
        log.silent.inspect.labeled("  [++]", added);
      }

      log.newline().heading("[DRY-RUN]", "Files");

      for (let removed of files.removed) {
        log.inspect.labeled("  [--]", removed);
      }

      for (let added of files.added) {
        log.silent.inspect.labeled("  [++]", added);
      }
    } else {
      for (let removed of directories.removed) {
        log.inspect.labeled("[--]", removed);
        shell.rm("-r", AbsolutePath.getFilename(removed));
      }

      for (let directory of directories.added) {
        log.inspect.labeled("[++]", directory);
        shell.mkdir("-p", AbsolutePath.getFilename(directory));
      }

      for (let removed of files.removed) {
        log.inspect.labeled("  [--]", removed);
        shell.rm(AbsolutePath.getFilename(removed));
      }

      for (let removed of this.#digests.removed) {
        log.inspect.labeled("  [--]", removed);
        shell.rm(AbsolutePath.getFilename(removed));
      }
    }
  }
}

class TranspileTask {
  static create(
    input: AbsolutePath,
    output: AbsolutePath,
    digest: AbsolutePath
  ): TranspileTask {
    return new TranspileTask(input, output, digest);
  }

  readonly #digest: AbsolutePath;

  private constructor(
    readonly input: AbsolutePath,
    readonly output: AbsolutePath,
    digest: AbsolutePath
  ) {
    this.#digest = digest;
  }

  async #digests(): Promise<{ prev: string | null; next: string }> {
    let prev = await this.#digest.read();
    let input = await this.input.read();

    if (input === null) {
      throw Error(`Unable to read ${AbsolutePath.getFilename(this.input)}`);
    }

    let next = digest(input);

    return { prev, next };
    // let next
  }

  async transpile() {
    log.silent.inspect.labeled("[TRANSPILE-TASK]", {
      input: this.input,
      output: this.output,
      digest: this.#digest,
    });

    let digests = await this.#digests();

    if (digests.prev === digests.next) {
      log.silent.inspect.labeled("[FRESH]", this.input);
      return;
    } else {
      log.inspect.labeled("[STALE]", this.input);
    }

    let output = swc.transformFileSync(AbsolutePath.getFilename(this.input), {
      sourceMaps: "inline",
      inlineSourcesContent: true,
      jsc: {
        parser: {
          syntax: "typescript",
          decorators: true,
        },
        target: "es2022",
      },
      outputPath: AbsolutePath.getFilename(this.output),
    });

    log.silent.inspect.labeled("[WRITING]", {
      file: this.output,
      code: output.code,
    });

    await fs.writeFile(AbsolutePath.getFilename(this.#digest), digests.next, {
      encoding: "utf-8",
    });
    await fs.writeFile(AbsolutePath.getFilename(this.output), output.code);
  }
}

async function workspacePackages(root: string, filter: string) {
  let stdout = await exec(
    sh`pnpm m ls --filter ./${filter} --depth -1 --porcelain`
  );

  if (stdout === undefined) {
    return [];
  }

  return stdout
    .split("\n")
    .filter((file) => file !== "" && file !== root)
    .map((p) => path.relative(root, p));
}

interface ExecErrorOptions extends ErrorOptions {
  code: number | null;
  command: string;
}

class ExecError extends Error {
  readonly #code: number | null;
  readonly #command: string;

  constructor(message: string, options: ExecErrorOptions) {
    super(message, options);

    this.#code = options.code;
    this.#command = options.command;

    Error.captureStackTrace(this, this.constructor);
  }

  get code(): number | "unknown" {
    return this.#code ?? "unknown";
  }

  get message(): string {
    let message = super.message;
    let header = `Exec Failed with code=${this.code}\n  (in ${this.#command})`;

    if (message) {
      return `${header}\n\n${message}`;
    } else {
      return header;
    }
  }
}

function exec(command: string): Promise<string | undefined> {
  return new Promise((fulfill, reject) => {
    let child = shell.exec(command, { silent: true, async: true });

    let stdout = readAll(child.stdout);
    let stderr = readAll(child.stderr);

    child.on("error", (err) => reject(err));
    child.on("exit", async (code) => {
      log.silent("exec status", { code, stdout: await stdout });

      if (code === 0) {
        fulfill(await stdout);
      } else {
        log("exec error", {
          error: await stderr,
          out: await stdout,
          code,
          command,
        });
        reject(new ExecError((await stderr) ?? "", { code, command }));
      }
    });
  });
}

interface ReadableStream extends NodeJS.ReadableStream {
  closed?: boolean;
  destroyed?: boolean;
  destroy?(): void;
}

async function readAll(
  readable?: ReadableStream | null
): Promise<string | undefined> {
  if (readable === undefined || readable === null) {
    return;
  }

  let result = await new PromiseReadable(readable).readAll();

  if (result === undefined) {
    return undefined;
  } else if (typeof result === "string") {
    return result;
  } else {
    return result.toString("utf-8");
  }
}

const PARTS_MATCHER = /^(?<file>[^.]*)(?:[.](?<ext>.*))?$/;

interface FileParts {
  readonly parent: string | null;
  readonly basename: {
    readonly file: string;
    readonly ext: string | null;
  };
  readonly kind?: AbsolutePathKind;
}

function getParts(filename: string): FileParts {
  let parent = getParent(filename);
  let basename = path.basename(filename);

  let extension = basename.match(PARTS_MATCHER);

  if (extension === null) {
    return { parent, basename: { file: basename, ext: null } };
  }

  let { file, ext } = extension.groups!;

  return {
    parent,
    basename: { file, ext },
    kind: parent === null ? "root" : undefined,
  };

  // let [, basename, extname];
}

function getParent(filename: string): string | null {
  let parent = path.dirname(filename);
  let root = path.parse(parent).root;

  if (filename === root) {
    return null;
  } else {
    return parent;
  }
}

function changeExtension(file: string, to: string): string {
  const basename = path.basename(file, path.extname(file));
  return path.join(path.dirname(file), `${basename}.${to}`);
}

function exhaustive(value: never, description: string): never {
  throw Error(`Expected ${description} to be exhaustively checked`);
}

const LABEL = Symbol("LABEL");
type LABEL = typeof LABEL;

interface Label {
  readonly [LABEL]: readonly string[];
}

function Label(...label: string[]): Label {
  return { [LABEL]: label };
}

function isLabel(value: unknown): value is Label {
  return typeof value === "object" && value !== null && LABEL in value;
}

interface Log {
  (value: unknown): Log;
  (label: string, value: unknown): Log;
  (label: unknown): Log;

  readonly log: Log;
  readonly silent: Log;

  newline(): Log;
  heading(...label: string[]): Log;

  readonly inspect: {
    (value: unknown, options?: util.InspectOptions): Log;
    labeled(
      label: string | Label,
      value: unknown,
      options?: util.InspectOptions
    ): Log;
  };
}

const SILENT: Log = (() => {
  const log = (...args: unknown[]): Log => SILENT;
  log.log = log;
  log.silent = log;

  log.newline = () => log;
  log.heading = (...label: string[]) => log;

  const inspect = (value: unknown, options?: util.InspectOptions) => log;
  inspect.labeled = (...args: unknown[]): Log => log;
  log.inspect = inspect;

  return log;
})();

function log(value: unknown): Log;
function log(label: string, value: unknown): Log;
function log(label: unknown): Log;
function log(
  ...args: [value: unknown] | [label: string, value: unknown] | [Label]
): Log {
  if (args.length === 2) {
    let [label, value] = args;
    console.log(label, util.inspect(value, { depth: null, colors: true }));
  } else {
    let [value] = args;

    if (isLabel(value)) {
      console.log(...value[LABEL]);
    } else {
      console.log(util.inspect(value, { depth: null, colors: true }));
    }
  }

  return log;
}

log.silent = SILENT;
log.log = log;

log.newline = (): typeof log => {
  console.log("\n");
  return log;
};

log.heading = (...label: string[]): typeof log => {
  console.log(...label);
  return log;
};

const logLabeled = (
  label: string | Label,
  value: unknown,
  options?: util.InspectOptions
): typeof log => {
  logLabeledValue(label, value, options);
  return log;
};

const logInspect = (
  value: unknown,
  options?: util.InspectOptions
): typeof log => {
  console.log(inspect(value, options));
  return log;
};

logInspect.labeled = logLabeled;

log.inspect = logInspect;

function logLabeledValue(
  label: string | Label,
  value: unknown,
  options: util.InspectOptions = {}
): void {
  if (isLabel(label)) {
    console.log(...label[LABEL], inspect(value, options));
  } else {
    console.log(label, inspect(value, options));
  }
}

function inspect(value: unknown, options: util.InspectOptions = {}): string {
  return util.inspect(value, { ...options, depth: null, colors: true });
}

function logged<T>(value: T, description: string, shouldLog = true): T {
  if (shouldLog) {
    console.log(
      description,
      "=",
      util.inspect(value, { depth: null, colors: true })
    );
  }
  return value;
}

function digest(source: string): string {
  let hash = createHash("sha256");
  hash.update(source);
  return hash.digest("hex");
}
