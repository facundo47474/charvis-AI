# Script para liberar el puerto 3000 y reiniciar Charvis
Write-Host "🔧 Liberando puerto 3000..." -ForegroundColor Yellow

# Liberar puerto 3000
try {
    Get-NetTCPConnection -LocalPort 3000 -ErrorAction Stop | ForEach-Object {
        Stop-Process -Id $_.OwningProcess -Force
        Write-Host "✅ Proceso $($_.OwningProcess) detenido" -ForegroundColor Green
    }
} catch {
    Write-Host "ℹ️  No hay procesos usando el puerto 3000" -ForegroundColor Blue
}

Write-Host "🚀 Iniciando Charvis..." -ForegroundColor Green
npm run dev