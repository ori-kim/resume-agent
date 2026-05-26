import type { HealthResponse } from '@resumagent/shared';

export async function fetchHealth(serverUrl: string): Promise<HealthResponse> {
  const response = await fetch(`${serverUrl}/health`, {
    method: 'GET',
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`health check 실패 (${response.status}): ${message}`);
  }

  const json = (await response.json()) as HealthResponse;

  if (!json?.status) {
    throw new Error('health 응답 형식이 올바르지 않습니다.');
  }

  return json;
}
