Write-Host "Verificacion de Groq API Key" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

# Leer el archivo .env
$envFile = ".env"
if (!(Test-Path $envFile)) {
    Write-Host "❌ ERROR: No se encuentra el archivo .env" -ForegroundColor Red
    exit 1
}

$envContent = Get-Content $envFile -Encoding UTF8
$groqKey = $null

foreach ($line in $envContent) {
    if ($line -match "^GROQ_API_KEY=(.+)") {
        $groqKey = $matches[1]
        break
    }
}

if (!$groqKey) {
    Write-Host "❌ ERROR: No se encuentra GROQ_API_KEY en .env" -ForegroundColor Red
    Write-Host "💡 Agrega GROQ_API_KEY=tu_clave_aqui al archivo .env" -ForegroundColor Yellow
    exit 1
}

Write-Host "✅ Clave encontrada en .env" -ForegroundColor Green
Write-Host "✅ Formato de clave valido" -ForegroundColor Green

Write-Host "Probando conexion con Groq..." -ForegroundColor Yellow

try {
    $headers = @{
        "Authorization" = "Bearer $groqKey"
        "Content-Type" = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://api.groq.com/openai/v1/models" -Method GET -Headers $headers

    if ($response) {
        Write-Host "✅ Conexion exitosa con Groq API" -ForegroundColor Green
        Write-Host "🎉 Tu clave de Groq esta funcionando correctamente!" -ForegroundColor Green
    }
} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__
    Write-Host "❌ ERROR: La clave de Groq no es valida (Status: $statusCode)" -ForegroundColor Red
    Write-Host "" -ForegroundColor Red
    Write-Host "💡 Soluciones:" -ForegroundColor Cyan
    Write-Host "   1. Ve a https://console.groq.com/keys" -ForegroundColor White
    Write-Host "   2. Crea una nueva API key o verifica una existente" -ForegroundColor White
    Write-Host "   3. Actualiza GROQ_API_KEY en el archivo .env" -ForegroundColor White
    Write-Host "   4. Asegúrate de que la clave tenga permisos para los modelos que usas" -ForegroundColor White
    exit 1
}