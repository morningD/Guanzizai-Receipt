$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Security
$action = [Console]::In.ReadLine()
$scope = [System.Security.Cryptography.DataProtectionScope]::CurrentUser
$service = [Convert]::FromBase64String([Console]::In.ReadLine())
$payload = [Convert]::FromBase64String([Console]::In.ReadLine())
$sha = [System.Security.Cryptography.SHA256]::Create()
try {
    $entropy = $sha.ComputeHash($service)
    if ($action -eq 'protect') {
        $result = [System.Security.Cryptography.ProtectedData]::Protect($payload, $entropy, $scope)
    } elseif ($action -eq 'unprotect') {
        $result = [System.Security.Cryptography.ProtectedData]::Unprotect($payload, $entropy, $scope)
    } else {
        throw 'Invalid credential operation'
    }
    [Console]::Out.WriteLine([Convert]::ToBase64String($result))
} finally {
    $sha.Dispose()
    [Array]::Clear($payload, 0, $payload.Length)
}
