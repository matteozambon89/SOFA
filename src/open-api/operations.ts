import {
  FieldNode,
  GraphQLSchema,
  isEnumType,
  Kind,
  ObjectTypeDefinitionNode,
  OperationDefinitionNode,
  parse,
  printType,
  TypeNode,
  VariableDefinitionNode,
} from 'graphql';

import { getOperationInfo } from '../ast';
import { addExampleFromDirective, mapToPrimitive, mapToRef } from './utils';
import { resolveFieldType } from './types';
import { titleCase } from 'title-case';
import { OpenAPIV3 } from 'openapi-types';
import { OpenAPIBuildPathFromOperationOpts } from '../types';

export function buildPathFromOperation({
  url,
  schema,
  operation,
  useRequestBody,
  tags,
  description,
  customScalars,
  exampleDirective,
  exampleDirectiveParser,
}: OpenAPIBuildPathFromOperationOpts): OpenAPIV3.OperationObject {
  const info = getOperationInfo(operation)!;
  const enumTypes = resolveEnumTypes(schema);

  const summary = resolveDescription(schema, info.operation);
  const variables = info.operation.variableDefinitions;
  const pathParams = variables?.filter((variable: any) =>
    isInPath(url, variable.variable.name.value)
  );
  const bodyParams = variables?.filter(
    (variable: any) => !isInPath(url, variable.variable.name.value)
  );

  return {
    tags,
    description,
    summary,
    operationId: info.name,
    ...(useRequestBody
      ? {
          parameters: resolveParameters(
            url,
            pathParams,
            schema,
            info.operation,
            {
              customScalars,
              enumTypes,
              exampleDirective,
              exampleDirectiveParser,
            }
          ),
          requestBody: {
            content: {
              'application/json': {
                schema: resolveRequestBody(bodyParams, schema, info.operation, {
                  customScalars,
                  enumTypes,
                  exampleDirective,
                  exampleDirectiveParser,
                }),
              },
            },
          },
        }
      : {
          parameters: resolveParameters(
            url,
            variables,
            schema,
            info.operation,
            {
              customScalars,
              enumTypes,
              exampleDirective,
              exampleDirectiveParser,
            }
          ),
        }),
    responses: {
      200: {
        description: summary,
        content: {
          'application/json': {
            schema: resolveResponse({
              schema,
              operation: info.operation,
              opts: {
                customScalars,
                exampleDirective,
                exampleDirectiveParser,
              },
            }),
          },
        },
      },
    },
  };
}

function resolveEnumTypes(schema: GraphQLSchema): Record<string, any> {
  const enumTypes = Object.values(schema.getTypeMap()).filter(isEnumType);
  return Object.fromEntries(
    enumTypes.map((type) => [
      type.name,
      {
        type: 'string',
        enum: type.getValues().map((value) => value.name),
      },
    ])
  );
}

function resolveParameters(
  url: string,
  variables: ReadonlyArray<VariableDefinitionNode> | undefined,
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  opts: Pick<
    OpenAPIBuildPathFromOperationOpts,
    'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  > & { enumTypes: Record<string, any> }
) {
  if (!variables) {
    return [];
  }

  return variables.map((variable: any) => {
    return {
      in: isInPath(url, variable.variable.name.value) ? 'path' : 'query',
      name: variable.variable.name.value,
      required: variable.type.kind === Kind.NON_NULL_TYPE,
      schema: resolveParamSchema(variable.type, { schema, ...opts }),
      description: resolveVariableDescription(schema, operation, variable),
    };
  });
}

export function resolveRequestBody(
  variables: ReadonlyArray<VariableDefinitionNode> | undefined,
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  opts: Pick<
    OpenAPIBuildPathFromOperationOpts,
    'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  > & { enumTypes: Record<string, any> }
) {
  if (!variables) {
    return {};
  }

  const properties: Record<string, any> = {};
  const required: string[] = [];

  variables.forEach((variable) => {
    if (variable.type.kind === Kind.NON_NULL_TYPE) {
      required.push(variable.variable.name.value);
    }

    properties[variable.variable.name.value] = {
      ...resolveParamSchema(variable.type, { schema, ...opts }),
      description: resolveVariableDescription(schema, operation, variable),
    };
  });

  return {
    type: 'object',
    properties,
    ...(required.length ? { required } : {}),
  };
}

// array -> [type]
// type -> $ref
// scalar -> swagger primitive
export function resolveParamSchema(
  type: TypeNode,
  opts: Pick<
    OpenAPIBuildPathFromOperationOpts,
    'schema' | 'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  > & { enumTypes: Record<string, any> }
): any {
  if (type.kind === Kind.NON_NULL_TYPE) {
    return resolveParamSchema(type.type, opts);
  }

  if (type.kind === Kind.LIST_TYPE) {
    let items = resolveParamSchema(type.type, opts);
    items = addExampleFromDirective(items, type.type, opts);
    return {
      type: 'array',
      items,
    };
  }

  if (opts.customScalars[type.name.value]) {
    return { $ref: mapToRef(type.name.value) };
  }

  return (
    mapToPrimitive(type.name.value) ||
    opts.enumTypes[type.name.value] || { $ref: mapToRef(type.name.value) }
  );
}

export function resolveResponse({
  schema,
  operation,
  opts,
}: {
  schema: GraphQLSchema;
  operation: OperationDefinitionNode;
  opts: Pick<
    OpenAPIBuildPathFromOperationOpts,
    'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  >;
}) {
  const operationType = operation.operation;
  const rootField = operation.selectionSet.selections[0];

  if (rootField.kind === Kind.FIELD) {
    if (operationType === 'query') {
      const queryType = schema.getQueryType()!;
      const field = queryType.getFields()[rootField.name.value];

      return resolveFieldType(field.type, { schema, ...opts });
    }

    if (operationType === 'mutation') {
      const mutationType = schema.getMutationType()!;
      const field = mutationType.getFields()[rootField.name.value];

      return resolveFieldType(field.type, { schema, ...opts });
    }
  }
}

export function isInPath(url: string, param: string): boolean {
  return url.includes(`:${param}`) || url.includes(`{${param}}`);
}

function getOperationFieldNode(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode
) {
  const selection = operation.selectionSet.selections[0] as FieldNode;
  const fieldName = selection.name.value;
  const typeDefinition = schema.getType(titleCase(operation.operation));

  if (!typeDefinition) {
    return undefined;
  }

  const definitionNode =
    typeDefinition.astNode || parse(printType(typeDefinition)).definitions[0];

  if (!isObjectTypeDefinitionNode(definitionNode)) {
    return undefined;
  }

  return definitionNode.fields!.find((field) => field.name.value === fieldName);
}

function resolveDescription(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode
) {
  const fieldNode = getOperationFieldNode(schema, operation);
  return fieldNode?.description?.value || '';
}

export function resolveVariableDescription(
  schema: GraphQLSchema,
  operation: OperationDefinitionNode,
  variable: VariableDefinitionNode
) {
  const fieldNode = getOperationFieldNode(schema, operation);
  const argument = fieldNode?.arguments?.find(
    (arg) => arg.name.value === variable.variable.name.value
  );

  return argument?.description?.value;
}

function isObjectTypeDefinitionNode(
  node: any
): node is ObjectTypeDefinitionNode {
  return node.kind === Kind.OBJECT_TYPE_DEFINITION;
}
