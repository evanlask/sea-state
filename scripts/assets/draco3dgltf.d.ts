// draco3dgltf ships without types; the pipeline only hands its modules to gltf-transform.

declare module 'draco3dgltf' {
  const draco3d: {
    createDecoderModule(): Promise<unknown>;
    createEncoderModule(): Promise<unknown>;
  };
  export default draco3d;
}
