import {
  GraphQLObjectType,
  GraphQLInputObjectType,
  GraphQLField,
  GraphQLInputField,
  isNonNullType,
  isListType,
  isObjectType,
  isScalarType,
  isEnumType,
  GraphQLType,
} from 'graphql';
import { addExampleFromDirective, mapToPrimitive, mapToRef } from './utils';
import { Sofa } from '../sofa';

export function buildSchemaObjectFromType(
  type: GraphQLObjectType | GraphQLInputObjectType,
  opts: Pick<
    Sofa,
    'schema' | 'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  >
): any {
  const required: string[] = [];
  const properties: Record<string, any> = {};

  const fields = type.getFields();

  for (const fieldName in fields) {
    const field = fields[fieldName];

    if (isNonNullType(field.type)) {
      required.push(field.name);
    }

    properties[fieldName] = resolveField(field, opts);
    if (field.description) {
      properties[fieldName].description = field.description;
    }

    properties[fieldName] = addExampleFromDirective(
      properties[fieldName],
      field,
      opts
    );
  }

  return {
    type: 'object',
    ...(required.length ? { required } : {}),
    properties,
    ...(type.description ? { description: type.description } : {}),
  };
}

function resolveField(
  field: GraphQLField<any, any> | GraphQLInputField,
  opts: Pick<
    Sofa,
    'schema' | 'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  >
) {
  return resolveFieldType(field.type, opts);
}

// array -> [type]
// type -> $ref
// scalar -> swagger primitive
export function resolveFieldType(
  type: GraphQLType,
  opts: Pick<
    Sofa,
    'schema' | 'customScalars' | 'exampleDirective' | 'exampleDirectiveParser'
  >
): any {
  if (isNonNullType(type)) {
    return resolveFieldType(type.ofType, opts);
  }

  if (isListType(type)) {
    let items = resolveFieldType(type.ofType, opts);
    items = addExampleFromDirective(items, type.ofType, opts);

    return {
      type: 'array',
      items,
    };
  }

  if (opts.customScalars[type.name]) {
    return {
      $ref: mapToRef(type.name),
    };
  }

  if (isObjectType(type)) {
    return {
      $ref: mapToRef(type.name),
    };
  }

  if (isScalarType(type)) {
    const resolved = mapToPrimitive(type.name) ||
      type.extensions?.jsonSchema || {
        type: 'object',
      };
    return { ...resolved };
  }

  if (isEnumType(type)) {
    return {
      type: 'string',
      enum: type.getValues().map((value) => value.name),
    };
  }

  return {
    type: 'object',
  };
}
