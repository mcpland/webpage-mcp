declare module 'cross-spawn' {
  const spawn: typeof import('node:child_process').spawn;
  export default spawn;
}
