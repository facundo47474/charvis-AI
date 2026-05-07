# Script para verificar y configurar la clave de OpenAI
Write-Host "Verificacion de OpenAI API Key" -ForegroundColor Cyan
Write-Host "================================" -ForegroundColor Cyan

# Verificar si existe el archivo .env
$envPath = ".\.env"
if (!(Test-Path $envPath)) {
    Write-Host "ERROR: No se encontro el archivo .env" -ForegroundColor Red
    exit 1
}

# Leer la clave actual
$envContent = Get-Content $envPath
$openaiKey = $envContent | Where-Object { $_ -match "^OPENAI_API_KEY=" } | ForEach-Object { $_.Split('=', 2)[1] }

if (!$openaiKey) {
    Write-Host "ERROR: No se encontro OPENAI_API_KEY en .env" -ForegroundColor Red
    Write-Host "Agrega esta linea al archivo .env:" -ForegroundColor Yellow
    Write-Host "   OPENAI_API_KEY=tu_clave_aqui" -ForegroundColor White
    exit 1
}

Write-Host "Clave encontrada en .env" -ForegroundColor Green

# Verificar formato basico
if ($openaiKey -notmatch "^sk-") {
    Write-Host "ERROR: La clave no tiene el formato correcto (debe empezar con 'sk-')" -ForegroundColor Red
    exit 1
}

Write-Host "Formato de clave valido" -ForegroundColor Green

# Probar la clave con una peticion simple
Write-Host "Probando conexion con OpenAI..." -ForegroundColor Yellow

try {
    $headers = @{
        "Authorization" = "Bearer $openaiKey"
        "Content-Type" = "application/json"
    }

    $response = Invoke-RestMethod -Uri "https://api.openai.com/v1/models" -Method GET -Headers $headers -TimeoutSec 10

    Write-Host "Clave de OpenAI valida y funcionando!" -ForegroundColor Green
    Write-Host "Tu Charvis esta listo para usar." -ForegroundColor Green

} catch {
    $statusCode = $_.Exception.Response.StatusCode.value__

    if ($statusCode -eq 401) {
        Write-Host "ERROR: La clave de OpenAI no es valida" -ForegroundColor Red
        Write-Host "" -ForegroundColor White
        Write-Host "Como solucionarlo:" -ForegroundColor Yellow
        Write-Host "   1. Ve a: https://platform.openai.com/api-keys" -ForegroundColor White
        Write-Host "   2. Crea una nueva API key" -ForegroundColor White
        Write-Host "   3. Copia la clave completa" -ForegroundColor White
        Write-Host "   4. Actualiza OPENAI_API_KEY en el archivo .env" -ForegroundColor White
        Write-Host "   5. Asegurate de que la clave tenga permisos para GPT-4o" -ForegroundColor White
        Write-Host "" -ForegroundColor White
        Write-Host "Despues de actualizar, ejecuta: npm run dev" -ForegroundColor Cyan
    } elseif ($statusCode -eq 429) {
        Write-Host "Limite de uso excedido. Espera un momento." -ForegroundColor Yellow
    } else {
        Write-Host "Error de conexion: $($_.Exception.Message)" -ForegroundColor Red
        Write-Host "Verifica tu conexion a internet" -ForegroundColor Yellow
    }

    exit 1
}

Write-Host ""
Write-Host "Iniciando Charvis..." -ForegroundColor Green
npm run dev