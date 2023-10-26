import { RouterRequest } from 'fets';
import { HTTPMethod } from 'fets/typings/typed-fetch';
import { DocumentNode, GraphQLSchema } from 'graphql';
import { OpenAPIV3 } from 'openapi-types';

export type ContextValue = Record<string, any>;

export type Ignore = string[];

export interface OpenAPIConfig {
  schema: GraphQLSchema;
  info: OpenAPIV3.InfoObject;
  servers?: OpenAPIV3.ServerObject[];
  components?: Record<string, any>;
  security?: OpenAPIV3.SecurityRequirementObject[];
  tags?: OpenAPIV3.TagObject[];
  /**
   * Override mapping of custom scalars to OpenAPI
   * @example
   * ```js
   * {
   *   Date: { type: "string",  format: "date" }
   * }
   * ```
   */
  customScalars?: Record<string, any>;
  exampleDirective?: string;
  exampleDirectiveParser?: ExampleDirectiveParser;
}

export interface OpenAPIBuildPathFromOperationOpts {
  url: string;
  schema: GraphQLSchema;
  operation: DocumentNode;
  useRequestBody: boolean;
  tags?: string[];
  description?: string;
  customScalars: Record<string, any>;
  exampleDirective?: string;
  exampleDirectiveParser?: ExampleDirectiveParser;
}

export interface RouteInfo {
  document: DocumentNode;
  path: string;
  method: HTTPMethod;
  tags?: string[];
  description?: string;
}

export type ContextFn = (
  serverContext: DefaultSofaServerContext
) => Promise<ContextValue> | ContextValue;

export type DefaultSofaServerContext = {
  request: RouterRequest;
};

export type ExampleDirectiveParser = (
  directive: Record<string, any>[]
) => string | undefined;
