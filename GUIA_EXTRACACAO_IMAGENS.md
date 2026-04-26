# 🖼️ Extração de Imagens Reais - Guia de Uso

## ⚠️ IMPORTANTE

O sistema **agora extrai imagens REAIS** do PDF ao invés de fazer um "print" da página inteira.

### Antes (problema):
- ❌ Renderizava a página inteira como imagem (canvas screenshot)
- ❌ Perdia qualidade e criava arquivos muito grandes
- ❌ Não era uma verdadeira imagem embutida no PDF

### Agora (solução):
- ✅ Extrai as imagens reais que estão embutidas no PDF original
- ✅ Preserva qualidade original das imagens
- ✅ Arquivo PDF mais leve e profissional

---

## 🚀 Como Usar

### 1. Iniciar o servidor de API (OBRIGATÓRIO)

**Opção A: Usar o batch file (Windows)**
```bash
double-click start_api.bat
```

**Opção B: Linha de comando**
```bash
cd "c:\Users\Henrique\Documents\GitHub\normalizador de lista\normalizado-de-lista"
python api.py
```

Você verá:
```
 * Running on http://127.0.0.1:5000
```

✅ O servidor está pronto!

### 2. Abrir a interface web

Abra `index.html` no navegador (mesma forma que antes).

### 3. Fazer upload do PDF

- Selecione seu PDF com imagens/gráficos
- O sistema vai:
  1. Extrair o texto (como antes)
  2. **Chamar a API para extrair as imagens REAIS**
  3. Mostrar a preview com as imagens verdadeiras
  4. Gerar o PDF com imagens genuínas ao baixar

---

## 🔧 O que mudou no código

### Novo arquivo: `api.py`
- Servidor Flask rodando em `http://127.0.0.1:5000`
- Endpoint: `POST /api/extract-images`
- Extrai imagens reais usando PyMuPDF
- Retorna imagens em base64

### Atualizado: `app.js`
```javascript
// ❌ ANTES: Renderizava canvas
const scale = 2;
const canvas = document.createElement('canvas');
await page.render({ canvasContext: ctx, viewport });

// ✅ AGORA: Chama API para imagens reais
const response = await fetch('http://127.0.0.1:5000/api/extract-images', {
  method: 'POST',
  body: formData,
});
```

### Atualizado: `generatePDF()`
```javascript
// ❌ ANTES: Usava canvas convertido para PNG
const imgBytes = canvasToPngBytes(imgData.canvas);

// ✅ AGORA: Usa imagens reais em base64
const base64Data = imgData.data.split(',')[1];
const binaryStr = atob(base64Data);
const imgBytes = new Uint8Array(binaryStr.length);
```

---

## 📋 Requisitos

- **Flask** (instalado automaticamente)
- **PyMuPDF** (já estava instalado)
- **Python 3.10+**
- Arquivo `.venv` com dependências ativas

### Instalar dependências (se necessário)
```bash
python -m pip install -r requirements.txt
```

---

## 🐛 Troubleshooting

### "Aviso: não foi possível extrair imagens reais"
- Verifique se `api.py` está rodando em outro terminal
- Cheque se a porta 5000 não está em uso
- Abra o console do navegador (F12) e veja os logs

### Imagens ainda não aparecem
- Confirme que o endpoint está respondendo:
  ```bash
  curl http://127.0.0.1:5000/api/extract-images
  ```
- Se falhar, o servidor Flask não está rodando

### Erro de CORS
- Normal em ambiente local - `fetch()` tem restrições
- Se acontecer, tente em `http://localhost:8000` em vez de file://

---

## ✨ Próximos passos

Se tudo estiver funcionando:
1. ✅ Teste com o PDF "Lista_1_-_Modelagem_Matemtica (1).pdf"
2. ✅ Verifique se as imagens/gráficos aparecem na preview
3. ✅ Baixe o PDF e confirme que as imagens estão lá (reais, não screenshots)
4. ✅ Compare com a versão anterior - deve estar mais limpo!

---

**Desenvolvido com ❤️ para melhorar a qualidade dos PDFs normalizados**
