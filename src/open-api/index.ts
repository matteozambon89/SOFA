import { isObjectType, isInputObjectType, isIntrospectionType } from 'graphql';

import { buildSchemaObjectFromType } from './types';
import { buildPathFromOperation } from './operations';
import { OpenAPIConfig, RouteInfo } from '../types';
import { OpenAPIV3 } from 'openapi-types';
import { normalizePathParamForOpenAPI } from './utils';

export function OpenAPI({
  schema,
  info,
  servers,
  components,
  security,
  tags,
  customScalars = {},
  exampleDirective,
  exampleDirectiveParser,
}: OpenAPIConfig) {
  const types = schema.getTypeMap();
  const swagger: OpenAPIV3.Document = {
    openapi: '3.0.0',
    info,
    servers,
    tags: [],
    paths: {},
    components: {
      schemas: {},
    },
  };

  for (const typeName in types) {
    const type = types[typeName];

    if (
      (isObjectType(type) || isInputObjectType(type)) &&
      !isIntrospectionType(type)
    ) {
      swagger.components!.schemas![typeName] = buildSchemaObjectFromType(type, {
        schema,
        customScalars,
        exampleDirective,
        exampleDirectiveParser,
      });
    }
  }

  if (components) {
    swagger.components = { ...components, ...swagger.components };
  }

  if (security) {
    swagger.security = security;
  }

  if (tags) {
    swagger.tags = tags;
  }

  return {
    addRoute(
      info: RouteInfo,
      config?: {
        basePath?: string;
      }
    ) {
      const basePath = config?.basePath || '';
      const path = basePath + normalizePathParamForOpenAPI(info.path);

      if (!swagger.paths[path]) {
        swagger.paths[path] = {};
      }

      const pathsObj = swagger.paths[path] as OpenAPIV3.PathItemObject;

      pathsObj[info.method.toLowerCase() as OpenAPIV3.HttpMethods] =
        buildPathFromOperation({
          url: path,
          operation: info.document,
          schema,
          useRequestBody: ['POST', 'PUT', 'PATCH'].includes(info.method),
          tags: info.tags || [],
          description: info.description || '',
          customScalars,
        });
    },
    get() {
      return swagger;
    },
  };
}
