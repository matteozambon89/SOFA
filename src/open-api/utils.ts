import { getDirective } from '@graphql-tools/utils';
import { OpenAPIV3 } from 'openapi-types';
import { Sofa } from '../sofa';

export function mapToPrimitive(type: string) {
  const formatMap: Record<string, any> = {
    Int: {
      type: 'integer',
      format: 'int32',
    },
    Float: {
      type: 'number',
      format: 'float',
    },
    String: {
      type: 'string',
    },
    Boolean: {
      type: 'boolean',
    },
    ID: {
      type: 'string',
    },
  };

  if (formatMap[type]) {
    return formatMap[type];
  }
}

export function mapToRef(type: string) {
  return `#/components/schemas/${type}`;
}

export function normalizePathParamForOpenAPI(path: string) {
  const pathParts = path.split('/');
  const normalizedPathParts = pathParts.map((part) => {
    if (part.startsWith(':')) {
      return `{${part.slice(1)}}`;
    }

    return part;
  });
  return normalizedPathParts.join('/');
}

export function addExampleFromDirective(
  component: OpenAPIV3.SchemaObject,
  node: any,
  opts: Pick<Sofa, 'schema' | 'exampleDirective' | 'exampleDirectiveParser'>
) {
  if (!opts.exampleDirective || !opts.exampleDirectiveParser) return component;

  const directive = getDirective(
    opts.schema,
    node as Parameters<typeof getDirective>['1'],
    opts.exampleDirective
  );
  if (!directive) return component;

  let example: any = opts.exampleDirectiveParser(directive);
  if (!example) return component;

  switch (component.type) {
    case 'string':
      example = String(example);
      break;
    case 'number':
      example = Number(example);
      break;
    case 'boolean':
      example = /^(yes|true|1)$/i.test(example);
      break;
    case 'integer':
      example = parseInt(example);
      break;
  }

  return { ...component, example };
}
