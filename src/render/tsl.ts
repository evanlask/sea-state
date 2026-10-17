// Loosely typed access to three's TSL for shader-graph code.
//
// @types/three models TSL node types precisely, but its generics fight common
// patterns (select() overloads, swizzles on storage elements, workgroup arrays,
// uniforms) and the shader graph is validated anyway when WGSL is generated and
// compiled. Shader-building code imports from here; module interfaces around it
// stay strictly typed.
import * as TSLModule from 'three/tsl';

// A TSL node of any type. Deliberately `any` so node math chains freely.
// oxlint-disable-next-line typescript/no-explicit-any
export type N = any;

export const tsl = TSLModule as unknown as Record<keyof typeof TSLModule, N>;
