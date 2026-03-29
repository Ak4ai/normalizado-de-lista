# Normalizador de lista (PDF -> PDF)

Este script le um PDF de exercicios, remove trechos de resolucao ja presentes e gera um novo arquivo `.pdf` com espaco para resolucao entre os blocos detectados (ex.: `Questao 01`, `R1`, `Exercicio 2`).

## 1) Instalar dependencias

```bash
pip install -r requirements.txt
```

## 2) Executar (usando o PDF desta pasta)

```bash
python normalizar_lista.py
```

Saida padrao: `lista_com_espaco_para_resolucao.pdf`

## 3) Exemplos uteis

Escolher outro arquivo de saida:

```bash
python normalizar_lista.py "Lista_1_-_Modelagem_Matemtica (1).pdf" -o "saida.pdf"
```

Aumentar o espaco para resolucao (15 linhas):

```bash
python normalizar_lista.py --answer-space-lines 15
```

Usar uma regex personalizada para detectar inicio dos blocos:

```bash
python normalizar_lista.py --start-regex "(?im)^\\s*(Questao\\s*\\d+|R\\s*\\d+)"
```

## Observacoes

- Se o PDF for escaneado (imagem sem texto selecionavel), sera necessario OCR antes.
- A regex padrao aceita variacoes com e sem acento para "Questao" e "Exercicio", alem de codigos como `R1` e `Q2`.
- A remocao da resolucao usa heuristicas (por exemplo, corta ao encontrar `Max Z`, `Min Z`, `Sujeito a`, `Resolucao`, etc.).
