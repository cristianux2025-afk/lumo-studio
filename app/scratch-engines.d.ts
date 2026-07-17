declare module "scratch-blocks";
declare module "@scratch/scratch-vm";
declare module "@scratch/scratch-render";
declare module "@scratch/scratch-svg-renderer";
declare module "scratch-audio";
declare module "scratch-storage";
interface ImportMetaEnv {
  readonly DEV: boolean;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
