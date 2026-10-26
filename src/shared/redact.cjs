module.exports = function redact(text) {
  return text
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1[已隐藏]@")
    .replace(
      /((?:authorization|proxy-authorization)["']?\s*[:=]\s*["']?(?:Bearer|Basic)\s+)[^\s"',;]+/gi,
      "$1[已隐藏]",
    )
    .replace(/((?:set-cookie|cookie)["']?\s*[:=]\s*)[^\r\n]+/gi, "$1[已隐藏]")
    .replace(
      /((?:["']?)(?:password|passwd|pwd|storePassword|keyPassword|privateKey|private_key|secretKey|aesKey|signKey|api_key|apiKey|access_token|refresh_token|token|secret)(?:["']?)\s*(?:[=:]\s*|\s+(?=["'])))(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;&<>]+)/gi,
      "$1[已隐藏]",
    )
    .replace(
      /(<(?:password|passwd|privateKey|private_key|secretKey|token|secret)>)[^<]*(<\/[^>]+>)/gi,
      "$1[已隐藏]$2",
    );
};
