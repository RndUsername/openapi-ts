import path from 'node:path';

import { loadConfig } from 'c12';
import { sync } from 'cross-spawn';

import { parse } from './openApi';
import type { Client } from './types/client';
import type { Config, UserConfig } from './types/config';
import { getConfig, setConfig } from './utils/config';
import { getOpenApiSpec } from './utils/getOpenApiSpec';
import { registerHandlebarTemplates } from './utils/handlebars';
import { postProcessClient } from './utils/postprocess';
import { writeClient } from './utils/write/client';

type OutputProcesser = {
  args: (path: string) => ReadonlyArray<string>;
  command: string;
  name: string;
};

/**
 * Map of supported formatters
 */
const formatters: Record<
  Extract<Config['output']['format'], string>,
  OutputProcesser
> = {
  biome: {
    args: (path) => ['format', '--write', path],
    command: 'biome',
    name: 'Biome (Format)',
  },
  prettier: {
    args: (path) => [
      '--ignore-unknown',
      path,
      '--write',
      '--ignore-path',
      './.prettierignore',
    ],
    command: 'prettier',
    name: 'Prettier',
  },
};

/**
 * Map of supported linters
 */
const linters: Record<
  Extract<Config['output']['lint'], string>,
  OutputProcesser
> = {
  biome: {
    args: (path) => ['lint', '--apply', path],
    command: 'biome',
    name: 'Biome (Lint)',
  },
  eslint: {
    args: (path) => [path, '--fix'],
    command: 'eslint',
    name: 'ESLint',
  },
};

const processOutput = () => {
  const config = getConfig();

  if (config.output.format) {
    const module = formatters[config.output.format];
    console.log(`✨ Running ${module.name}`);
    sync(module.command, module.args(config.output.path));
  }

  if (config.output.lint) {
    const module = linters[config.output.lint];
    console.log(`✨ Running ${module.name}`);
    sync(module.command, module.args(config.output.path));
  }
};

const logClientMessage = () => {
  const { client } = getConfig();
  switch (client) {
    case 'angular':
      return console.log('✨ Creating Angular client');
    case '@hey-api/client-axios':
    case 'axios':
      return console.log('✨ Creating Axios client');
    case '@hey-api/client-fetch':
    case 'fetch':
      return console.log('✨ Creating Fetch client');
    case 'node':
      return console.log('✨ Creating Node.js client');
    case 'xhr':
      return console.log('✨ Creating XHR client');
  }
};

const getOutput = (userConfig: UserConfig): Config['output'] => {
  let output: Config['output'] = {
    format: false,
    lint: false,
    path: '',
  };
  if (typeof userConfig.output === 'string') {
    output.path = userConfig.output;
  } else {
    output = {
      ...output,
      ...userConfig.output,
    };
  }
  return output;
};

const getSchemas = (userConfig: UserConfig): Config['schemas'] => {
  let schemas: Config['schemas'] = {
    export: true,
    type: 'json',
  };
  if (typeof userConfig.schemas === 'boolean') {
    schemas.export = userConfig.schemas;
  } else {
    schemas = {
      ...schemas,
      ...userConfig.schemas,
    };
  }
  return schemas;
};

const getServices = (userConfig: UserConfig): Config['services'] => {
  let services: Config['services'] = {
    export: true,
    name: '{{name}}Service',
    operationId: true,
    response: 'body',
  };
  if (typeof userConfig.services === 'boolean') {
    services.export = userConfig.services;
  } else if (typeof userConfig.services === 'string') {
    services.include = userConfig.services;
  } else {
    services = {
      ...services,
      ...userConfig.services,
    };
  }
  return services;
};

const getTypes = (userConfig: UserConfig): Config['types'] => {
  let types: Config['types'] = {
    dates: false,
    enums: false,
    export: true,
    name: 'preserve',
  };
  if (typeof userConfig.types === 'boolean') {
    types.export = userConfig.types;
  } else if (typeof userConfig.types === 'string') {
    types.include = userConfig.types;
  } else {
    types = {
      ...types,
      ...userConfig.types,
    };
  }
  return types;
};

const initConfig = async (userConfig: UserConfig) => {
  const { config: userConfigFromFile } = await loadConfig<UserConfig>({
    jitiOptions: {
      esmResolve: true,
    },
    name: 'openapi-ts',
    overrides: userConfig,
  });

  if (userConfigFromFile) {
    userConfig = { ...userConfigFromFile, ...userConfig };
  }

  const {
    base,
    client = 'fetch',
    debug = false,
    dryRun = false,
    exportCore = true,
    input,
    name,
    request,
    useOptions = true,
  } = userConfig;

  if (debug) {
    console.warn('userConfig:', userConfig);
  }

  const output = getOutput(userConfig);

  if (!input) {
    throw new Error(
      '🚫 input not provided - provide path to OpenAPI specification',
    );
  }

  if (!output.path) {
    throw new Error(
      '🚫 output not provided - provide path where we should generate your client',
    );
  }

  if (!useOptions) {
    console.warn(
      '⚠️ Deprecation warning: useOptions set to false. This setting will be removed in future versions. Please migrate useOptions to true https://heyapi.vercel.app/openapi-ts/migrating.html#v0-27-38',
    );
  }

  const schemas = getSchemas(userConfig);
  const services = getServices(userConfig);
  const types = getTypes(userConfig);

  output.path = path.resolve(process.cwd(), output.path);

  return setConfig({
    base,
    client,
    debug,
    dryRun,
    exportCore: client.startsWith('@hey-api') ? false : exportCore,
    input,
    name,
    output,
    request,
    schemas,
    services,
    types,
    useOptions,
  });
};

/**
 * Generate the OpenAPI client. This method will read the OpenAPI specification and based on the
 * given language it will generate the client, including the typed models, validation schemas,
 * service layer, etc.
 * @param userConfig {@link UserConfig} passed to the `createClient()` method
 */
export async function createClient(userConfig: UserConfig): Promise<Client> {
  const config = await initConfig(userConfig);

  const openApi =
    typeof config.input === 'string'
      ? await getOpenApiSpec(config.input)
      : (config.input as unknown as Awaited<ReturnType<typeof getOpenApiSpec>>);

  const client = postProcessClient(parse(openApi));
  const templates = registerHandlebarTemplates();

  if (!config.dryRun) {
    logClientMessage();
    await writeClient(openApi, client, templates);
    processOutput();
  }

  console.log('✨ Done! Your client is located in:', config.output.path);

  return client;
}

/**
 * Type helper for openapi-ts.config.ts, returns {@link UserConfig} object
 */
export function defineConfig(config: UserConfig): UserConfig {
  return config;
}

export default {
  createClient,
  defineConfig,
};
