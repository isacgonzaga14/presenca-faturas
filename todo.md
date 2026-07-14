# TODO — presenca-faturas

## Funcionalidades existentes (concluídas)
- [x] Importação de extrato PDF/CSV com auto-classificação por palavras-chave
- [x] 9 categorias com cores personalizáveis
- [x] Cards de movimento mensal (ENTRADA, SAÍDAS, IVA A DEDUZIR)
- [x] Conciliação por IA (upload paralelo de PDFs + LLM)
- [x] Extracção automática de IVA de cada PDF
- [x] Edição manual de IVA por linha
- [x] Painel IVA trimestral na aba Saúde da Empresa
- [x] Alerta de fecho de trimestre
- [x] Relatório PDF (tema claro, layout compacto, anotações)
- [x] Aba Saúde da Empresa com KPIs, gráfico, histórico 2025
- [x] Campo de documento com upload, anotações e eliminação

## Em curso
- [x] Simulador de Contrato / Calculadora de Custos Operacionais na aba Saúde da Empresa
  - Campos editáveis: nº funcionários, salário por funcionário, reserva fim de ano (%), pró-labore, taxa SS pró-labore, taxa SS patronal (opcional), contabilidade
  - Cálculo em tempo real: custo total operacional + margem de lucro → valor de contrato proposto
  - Persistência em localStorage
  - Valores padrão da tabela do Isac (4 func × 1.000€, reserva 10%, pró-labore 600€, SS 23%, contab. 140€, margem 20%)

## Novas tarefas
- [x] Modo reverso no Simulador de Contrato: inserir valor do contrato → calcular margem, lucro e distribuição automática
- [x] Geração de PDF profissional a partir do Simulador de Contrato (proposta para CEO do cliente)
