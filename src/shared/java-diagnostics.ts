// Eclipse JDT IProblem IDs for optional unchecked conversions and warning settings.
const quietJavaDiagnostics = new Set([
  "1102",      // ProblemNotAnalysed
  "16777746",  // UnsafeRawConstructorInvocation
  "16777747",  // UnsafeRawMethodInvocation
  "16777748",  // UnsafeTypeConversion
  "16777752",  // UnsafeRawFieldAssignment
  "16777761",  // UnsafeGenericCast
  "536871547", // UnusedWarningToken
]);

export function showJavaDiagnostic(diagnostic: { severity?: number; code?: number | string }) {
  return diagnostic.severity === 1 || !quietJavaDiagnostics.has(String(diagnostic.code));
}
