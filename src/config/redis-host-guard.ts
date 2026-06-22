/**
 * Guard de DB dedicado do BullMQ (Card 6.2 — fix-pack @dba MÉDIO F2).
 *
 * Predicado PURO (sem side-effects de import) que detecta se a conexão TCP do
 * BullMQ (`REDIS_URL`) e o Redis REST do rate-limit (`UPSTASH_REDIS_REST_URL`)
 * apontam para o MESMO host Upstash. No Upstash, REST e TCP são apenas dois
 * protocolos do mesmo database — se colidirem, o "DB dedicado" (decisão D-1)
 * quebra: as políticas `noeviction` (fila, não pode perder job) e TTL/evicção
 * (rate-limit) passam a compartilhar o database, e jobs em voo podem ser
 * despejados (cliente paga e não recebe output).
 *
 * Vive FORA do `env.ts` de propósito: `env.ts` roda o parse no import (efeito
 * colateral), então um teste que importasse o guard de lá dispararia o boot
 * inteiro. Aqui o predicado é testável isoladamente — é a rede de regressão
 * do guard, que o `env-validation.test.ts` (réplica do schema) não cobre.
 */

/**
 * Extrai o hostname lowercase de uma URL. Retorna `''` se a string não for
 * uma URL parseável — o caller trata `''` como "não comparável" (não colide).
 */
function hostnameOf(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

/**
 * `true` se ambas as URLs estiverem presentes, forem parseáveis e apontarem
 * para o MESMO hostname. `false` se alguma estiver ausente/inválida ou se os
 * hosts diferirem — a comparação ignora protocolo (`rediss://` vs `https://`),
 * porta e path, comparando só o host físico do database.
 */
export function redisHostsCollide(
  redisUrl: string | undefined,
  restUrl: string | undefined,
): boolean {
  if (!redisUrl || !restUrl) return false
  const tcpHost = hostnameOf(redisUrl)
  const restHost = hostnameOf(restUrl)
  return tcpHost !== '' && restHost !== '' && tcpHost === restHost
}
