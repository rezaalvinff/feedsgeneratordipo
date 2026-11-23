import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  // Background removal runs fully in the browser; keep the heavy ONNX runtime
  // out of any server bundle.
  serverExternalPackages: ["@imgly/background-removal", "onnxruntime-web"],
};

export default nextConfig;
