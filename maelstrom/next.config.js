/** @type {import('next').NextConfig} */
const isPagesExport = process.env.STATIC_EXPORT === "1";

const nextConfig = {
  images: {
    unoptimized: true,
  },
  ...(isPagesExport
    ? {
        output: "export",
        trailingSlash: true,
        basePath: "/account-generator",
      }
    : {}),
};

module.exports = nextConfig;
