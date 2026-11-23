/// <reference types="vite/client" />
interface ImportMetaEnv {
  readonly VITE_NX_HOST?: string;
  /** Desktop app: the server it opens by default (https://….onrender.com). */
  readonly VITE_NX_DEFAULT_HOST?: string;
}
declare module "*.module.css" {
  const classes: Record<string, string>;
  export default classes;
}
