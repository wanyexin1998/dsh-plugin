/**
 * Stylesheets authored next to components are inlined as text by the build and
 * injected inside the host bundle factory. At authoring time the same value is
 * used as a class-name map, hence the intersection type.
 */
declare module '*.css' {
  const css: string & Record<string, string>
  export default css
}
