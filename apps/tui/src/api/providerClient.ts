import type { ProviderCatalogResponse, ProviderName } from '@resumagent/shared';

export async function fetchProviderCatalog(
  serverUrl: string,
  options: {
    provider?: ProviderName;
    model?: string;
  } = {},
): Promise<ProviderCatalogResponse> {
  const url = new URL(`${serverUrl}/provider/catalog`);

  if (options.provider) {
    url.searchParams.set('provider', options.provider);
  }

  if (options.model) {
    url.searchParams.set('model', options.model);
  }

  const response = await fetch(url, {
    method: 'GET',
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(`provider catalog 조회 실패 (${response.status}): ${message}`);
  }

  const json = (await response.json()) as ProviderCatalogResponse;

  if (!json?.provider || !json?.activeModel || !Array.isArray(json?.models) || !json?.quota) {
    throw new Error('provider catalog 응답 형식이 올바르지 않습니다.');
  }

  return json;
}
