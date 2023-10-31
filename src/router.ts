import {
  DocumentNode,
  isObjectType,
  isNonNullType,
  Kind,
  OperationTypeNode,
  isIntrospectionType,
  isInputObjectType,
  GraphQLField,
} from 'graphql';
import {
  buildOperationNodeForField,
  createGraphQLError,
} from '@graphql-tools/utils';
import { getOperationInfo, OperationInfo } from './ast';
import type { Sofa, Route } from './sofa';
import type { RouteInfo, DefaultSofaServerContext } from './types';
import { convertName } from './common';
import { parseVariable } from './parse';
import { StartSubscriptionEvent, SubscriptionManager } from './subscriptions';
import { logger } from './logger';
import {
  Response,
  createRouter as createRouterInstance,
  RouterRequest,
  Router,
  RouteHandler,
  RouteSchemas,
} from 'fets';
import { HTTPMethod, StatusCode } from 'fets/typings/typed-fetch';
import {
  isInPath,
  resolveParamSchema,
  resolveRequestBody,
  resolveResponse,
  resolveVariableDescription,
} from './open-api/operations';
import { buildSchemaObjectFromType } from './open-api/types';
import { addExampleFromDirective, mapToRef } from './open-api/utils';

export type ErrorHandler = (errors: ReadonlyArray<any>) => Response;

declare module 'graphql' {
  interface GraphQLHTTPErrorExtensions {
    spec?: boolean;
    status?: number;
    headers?: Record<string, string>;
  }
  interface GraphQLErrorExtensions {
    http?: GraphQLHTTPErrorExtensions;
  }
}

const defaultErrorHandler: ErrorHandler = (errors) => {
  let status: StatusCode | undefined;
  const headers: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
  };

  for (const error of errors) {
    if (typeof error === 'object' && error != null && error.extensions?.http) {
      if (
        error.extensions.http.status &&
        (!status || error.extensions.http.status > status)
      ) {
        status = error.extensions.http.status;
      }
      if (error.extensions.http.headers) {
        Object.assign(headers, error.extensions.http.headers);
      }
      delete error.extensions.http;
    }
  }

  if (!status) {
    status = 500;
  }

  return Response.json(
    { errors },
    {
      status,
      headers,
    }
  );
};

function useRequestBody(
  method: HTTPMethod
): method is 'POST' | 'PUT' | 'PATCH' {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

export function createRouter(sofa: Sofa) {
  logger.debug('[Sofa] Creating router');

  sofa.openAPI ||= {};
  sofa.openAPI.info ||= {} as any;
  sofa.openAPI.info!.title ||= 'SOFA API';
  sofa.openAPI.info!.description ||= 'Generated by SOFA';
  sofa.openAPI.info!.version ||= '0.0.0';
  sofa.openAPI.components ||= {};
  sofa.openAPI.components.schemas ||= {};

  const types = sofa.schema.getTypeMap();
  for (const typeName in types) {
    const type = types[typeName];

    if (
      (isObjectType(type) || isInputObjectType(type)) &&
      !isIntrospectionType(type)
    ) {
      sofa.openAPI!.components!.schemas![typeName] = buildSchemaObjectFromType(
        type,
        {
          schema: sofa.schema,
          customScalars: sofa.customScalars,
          exampleDirective: sofa.exampleDirective,
          exampleDirectiveParser: sofa.exampleDirectiveParser,
        }
      );
    } else if (!isIntrospectionType(type) && sofa.customScalars[typeName]) {
      //* This creates any customScalar as a component reducing the amount of duplication
      sofa.openAPI.components.schemas[typeName] = addExampleFromDirective(
        {
          description: type.description,
          ...sofa.customScalars[typeName],
        },
        type,
        {
          schema: sofa.schema,
          exampleDirective: sofa.exampleDirective,
          exampleDirectiveParser: sofa.exampleDirectiveParser,
        }
      );
    }
  }

  const router = createRouterInstance<any>({
    base: sofa.basePath,
    openAPI: sofa.openAPI,
    swaggerUI: sofa.swaggerUI,
  });

  const queryType = sofa.schema.getQueryType();
  const mutationType = sofa.schema.getMutationType();
  const subscriptionManager = new SubscriptionManager(sofa);

  if (queryType) {
    Object.keys(queryType.getFields()).forEach((fieldName) => {
      createQueryRoute({ sofa, router, fieldName });
    });
  }

  if (mutationType) {
    Object.keys(mutationType.getFields()).forEach((fieldName) => {
      createMutationRoute({ sofa, router, fieldName });
    });
  }

  router.route({
    path: '/webhook',
    method: 'POST',
    async handler(request, serverContext) {
      const { subscription, variables, url }: StartSubscriptionEvent =
        await request.json();
      try {
        const sofaContext: DefaultSofaServerContext = Object.assign(
          serverContext,
          {
            request,
          }
        );
        const result = await subscriptionManager.start(
          {
            subscription,
            variables,
            url,
          },
          sofaContext
        );
        return Response.json(result);
      } catch (error) {
        return Response.json(error, {
          status: 500,
          statusText: 'Subscription failed',
        });
      }
    },
  });

  router.route({
    path: '/webhook/:id',
    method: 'POST',
    async handler(request, serverContext) {
      const id = request.params?.id!;
      const body = await request.json();
      const variables: any = body.variables;
      try {
        const sofaContext = Object.assign(serverContext, {
          request,
        });
        const contextValue = await sofa.contextFactory(sofaContext);
        const result = await subscriptionManager.update(
          {
            id,
            variables,
          },
          contextValue
        );
        return Response.json(result);
      } catch (error) {
        return Response.json(error, {
          status: 500,
          statusText: 'Subscription failed to update',
        });
      }
    },
  });

  router.route({
    path: '/webhook/:id',
    method: 'DELETE',
    async handler(request) {
      const id = request.params?.id!;
      try {
        const result = await subscriptionManager.stop(id);
        return Response.json(result);
      } catch (error) {
        return Response.json(error, {
          status: 500,
          statusText: 'Subscription failed to stop',
        });
      }
    },
  });

  if (sofa.batching.enabled) {
    sofa.openAPI.components.schemas['BatchItem'] = {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          format: 'uri',
          description: 'Request path',
        },
        method: {
          type: 'string',
          enum: ['POST', 'GET'],
          description: 'Request HTTP method',
        },
        params: {
          type: 'object',
          description:
            'Request body (when method is POST) or query string parameters (when method is GET)',
          additionalProperties: true,
        },
      },
      additionalProperties: false,
      required: ['path', 'method'],
    };

    router.route({
      path: '/batch',
      method: 'POST',
      schemas: {
        request: {
          json: {
            type: 'array',
            items: {
              $ref: mapToRef('BatchItem'),
            },
            minItems: 1,
          },
        },
      },
      async handler(request, serverContext) {
        const body = await request.json();

        if (body.length > sofa.batching.limit) {
          return Response.json(
            {
              message: `Batching is limited to ${sofa.batching.limit} operations per request.`,
            },
            { status: 413, statusText: 'Content Too Large' }
          );
        }

        const promises = body.map(
          async ({
            path,
            method,
            params,
          }: {
            path: string;
            method: 'GET' | 'POST';
            params?: Record<string, any>;
          }) => {
            const url = new URL(path, 'http://localhost');
            const opts: RequestInit = { method };

            if (params) {
              if (method === 'GET') {
                Object.entries(params).forEach(([key, value]) =>
                  url.searchParams.append(key, value)
                );
              } else {
                opts.body = JSON.stringify(params);
              }
            }

            const req = new Request(url, opts);

            const res = await router.handle(req, serverContext);

            const responseBody = {
              status: res.status,
              body: await res.json(),
            };

            return responseBody;
          }
        );

        const responses = await Promise.all(promises);
        return Response.json(responses);
      },
    });
  }

  return router;
}

function createQueryRoute({
  sofa,
  router,
  fieldName,
}: {
  sofa: Sofa;
  router: Router<any, {}, {}>;
  fieldName: string;
}): RouteInfo {
  logger.debug(`[Router] Creating ${fieldName} query`);

  const queryType = sofa.schema.getQueryType()!;
  const operationNode = buildOperationNodeForField({
    kind: 'query' as OperationTypeNode,
    schema: sofa.schema,
    field: fieldName,
    models: sofa.models,
    ignore: sofa.ignore,
    circularReferenceDepth: sofa.depthLimit,
  });
  const operation: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [operationNode],
  };
  const info = getOperationInfo(operation)!;
  const field = queryType.getFields()[fieldName];
  const fieldType = field.type;
  const isSingle =
    isObjectType(fieldType) ||
    (isNonNullType(fieldType) && isObjectType(fieldType.ofType));
  const hasIdArgument = field.args.some((arg) => arg.name === 'id');

  const graphqlPath = `${queryType.name}.${fieldName}`;
  const routeConfig = sofa.routes?.[graphqlPath];
  const route = {
    method: routeConfig?.method ?? 'GET',
    path: routeConfig?.path ?? getPath(fieldName, isSingle && hasIdArgument),
    responseStatus: routeConfig?.responseStatus ?? 200,
  };

  router.route({
    path: route.path,
    method: route.method,
    schemas: getRouteSchemas({
      field,
      method: route.method,
      path: route.path,
      info,
      sofa,
      responseStatus: route.responseStatus,
    }),
    handler: useHandler({ info, route, fieldName, sofa, operation }),
  });

  logger.debug(
    `[Router] ${fieldName} query available at ${route.method} ${route.path}`
  );

  return {
    document: operation,
    path: route.path,
    method: route.method.toUpperCase() as HTTPMethod,
    tags: routeConfig?.tags ?? [],
    description: routeConfig?.description ?? field.description ?? '',
  };
}

function getRouteSchemas({
  field,
  method,
  path,
  info,
  sofa,
  responseStatus,
}: {
  field: GraphQLField<any, any, any>;
  method: HTTPMethod;
  path: string;
  info: OperationInfo;
  sofa: Sofa;
  responseStatus: StatusCode;
}): RouteSchemas {
  const params = {
    properties: {} as Record<string, any>,
    required: [] as string[],
  };
  const query = {
    properties: {} as Record<string, any>,
    required: [] as string[],
  };

  for (const variable of info!.variables) {
    const varName = variable.variable.name.value;
    let varSchema = resolveParamSchema(variable.type, {
      schema: sofa.schema,
      customScalars: sofa.customScalars,
      enumTypes: sofa.enumTypes,
      exampleDirective: sofa.exampleDirective,
      exampleDirectiveParser: sofa.exampleDirectiveParser,
    });
    varSchema.description = resolveVariableDescription(
      sofa.schema,
      info!.operation,
      variable
    );
    //* Directive is available at the field level but not in the info level
    //* This solution attempts to find the arg which matches the same name as the variable
    //* If and only if the arg is matched then it'll be possible to extract the example
    const arg = field?.args.find(({ name }) => name === varName);
    if (arg) {
      varSchema = addExampleFromDirective(varSchema, arg, {
        schema: sofa.schema,
        exampleDirective: sofa.exampleDirective,
        exampleDirectiveParser: sofa.exampleDirectiveParser,
      });
    }
    const varObj = isInPath(path, varName) ? params : query;
    varObj.properties[varName] = varSchema;
    if (variable.type.kind === Kind.NON_NULL_TYPE) {
      varObj.required.push(varName);
    }
  }
  return {
    request: {
      json: useRequestBody(method)
        ? resolveRequestBody(info!.variables, sofa.schema, info!.operation, {
            customScalars: sofa.customScalars,
            enumTypes: sofa.enumTypes,
            exampleDirective: sofa.exampleDirective,
            exampleDirectiveParser: sofa.exampleDirectiveParser,
          })
        : undefined,
      params,
      query,
    },
    responses: {
      [responseStatus]: resolveResponse({
        schema: sofa.schema,
        operation: info!.operation,
        opts: {
          customScalars: sofa.customScalars,
          exampleDirective: sofa.exampleDirective,
          exampleDirectiveParser: sofa.exampleDirectiveParser,
        },
      }),
    },
  };
}

function createMutationRoute({
  sofa,
  router,
  fieldName,
}: {
  sofa: Sofa;
  router: Router<any, {}, {}>;
  fieldName: string;
}): RouteInfo {
  logger.debug(`[Router] Creating ${fieldName} mutation`);

  const mutationType = sofa.schema.getMutationType()!;
  const field = mutationType.getFields()[fieldName];
  const operationNode = buildOperationNodeForField({
    kind: 'mutation' as OperationTypeNode,
    schema: sofa.schema,
    field: fieldName,
    models: sofa.models,
    ignore: sofa.ignore,
    circularReferenceDepth: sofa.depthLimit,
  });
  const operation: DocumentNode = {
    kind: Kind.DOCUMENT,
    definitions: [operationNode],
  };
  const info = getOperationInfo(operation)!;

  const graphqlPath = `${mutationType.name}.${fieldName}`;
  const routeConfig = sofa.routes?.[graphqlPath];

  const method = routeConfig?.method ?? 'POST';
  const path = routeConfig?.path ?? getPath(fieldName);
  const responseStatus = routeConfig?.responseStatus ?? 200;

  const route: Route = {
    method,
    path,
    responseStatus,
  };

  router.route({
    method,
    path,
    schemas: getRouteSchemas({
      field,
      method,
      path,
      info,
      responseStatus,
      sofa,
    }),
    handler: useHandler({ info, route, fieldName, sofa, operation }),
  });

  logger.debug(`[Router] ${fieldName} mutation available at ${method} ${path}`);

  return {
    document: operation,
    path,
    method,
    tags: routeConfig?.tags || [],
    description: routeConfig?.description ?? field.description ?? '',
  };
}

function useHandler(config: {
  sofa: Sofa;
  info: OperationInfo;
  route: Route;
  operation: DocumentNode;
  fieldName: string;
}): RouteHandler<{}, RouterRequest, any> {
  const { sofa, operation, fieldName } = config;
  const info = config.info!;
  const errorHandler: ErrorHandler = sofa.errorHandler || defaultErrorHandler;

  return async (request: RouterRequest, serverContext: {}) => {
    try {
      let body = {};
      if (request.body != null) {
        const strBody = await request.text();
        if (strBody) {
          try {
            body = JSON.parse(strBody);
          } catch (error) {
            throw createGraphQLError('POST body sent invalid JSON.', {
              extensions: {
                http: {
                  status: 400,
                },
              },
            });
          }
        }
      }

      let variableValues = {};
      try {
        variableValues = info.variables.reduce((variables, variable) => {
          const name = variable.variable.name.value;
          const value = parseVariable({
            value: pickParam({
              url: request.url,
              body,
              params: request.params || {},
              name,
            }),
            variable,
            schema: sofa.schema,
          });

          if (typeof value === 'undefined') {
            return variables;
          }

          return {
            ...variables,
            [name]: value,
          };
        }, {});
      } catch (error: any) {
        throw createGraphQLError(error.message || error.toString?.() || error, {
          extensions: {
            http: {
              status: 400,
            },
          },
        });
      }

      const sofaContext = Object.assign(serverContext, {
        request,
      });
      const contextValue = await sofa.contextFactory(sofaContext);
      const result = await sofa.execute({
        schema: sofa.schema,
        document: operation,
        contextValue,
        variableValues,
        operationName: info.operation.name && info.operation.name.value,
      });

      if (result.errors) {
        return errorHandler(result.errors);
      }

      return Response.json(result.data?.[fieldName], {
        status: config.route.responseStatus,
      });
    } catch (error: any) {
      return errorHandler([error]);
    }
  };
}

function getPath(fieldName: string, hasId = false) {
  return `/${convertName(fieldName)}${hasId ? '/:id' : ''}`;
}

function pickParam({
  name,
  url,
  params,
  body,
}: {
  name: string;
  url: string;
  params: any;
  body: any;
}) {
  if (name in params) {
    return params[name];
  }
  const searchParams = new URLSearchParams(url.split('?')[1]);
  if (searchParams.has(name)) {
    const values = searchParams.getAll(name);
    return values.length === 1 ? values[0] : values;
  }
  if (body && body.hasOwnProperty(name)) {
    return body[name];
  }
}
