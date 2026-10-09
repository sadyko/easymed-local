// LIS_PROXY_V1 — модели, которые Easy-Med принимает через LIS Proxy (решение
// владельца 2026-10-09, п. 6): BS-200, BC-780, AutoLumo A1000. Типы прокси для
// BC-20 / BC-5300 путают поле штрихкода, тип CL-900i результатов не передаёт —
// эти приборы идут в Easy-Med напрямую. Один список на сервер (rpc/lis.js
// lis_device_add) и экран (lab-devices.js «Добавить»).
export const PROXY_MODELS = Object.freeze(['mindray-bs-200', 'mindray-bc-780', 'autobio-autolumo-a1000']);

/** Строка прибора — за LIS Proxy (мигр. 239, lab_devices.via). */
export const isProxyDevice = (d) => !!d && d.via === 'lisproxy';
