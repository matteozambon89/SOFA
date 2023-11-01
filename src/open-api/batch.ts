export const BatchItemComponent = {
  type: 'object',
  properties: {
    path: {
      type: 'string',
      format: 'uri',
      description: 'Request path',
      example: '/my/path',
    },
    method: {
      type: 'string',
      enum: ['POST', 'GET'],
      description: 'Request HTTP method',
      example: 'GET',
    },
    params: {
      type: 'object',
      description:
        'Request body (when method is POST) or query string parameters (when method is GET)',
      additionalProperties: true,
      example: {
        prop1: 'foo',
        prop2: 'bar',
      },
    },
  },
  additionalProperties: false,
  required: ['path', 'method'],
};

export const BatchResponseErrorComponent = {
  type: 'object',
  properties: {
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Error message',
          },
        },
        required: ['message'],
      },
      minItems: 1,
      maxItems: 1,
    },
  },
  required: ['errors'],
  example: {
    errors: [
      {
        message: 'Batching is limited to X operations per request.',
      },
    ],
  },
};

export const BatchResponseItemSuccessComponent = {
  type: 'object',
  properties: {
    status: {
      type: 'integer',
      example: 200,
      default: 200,
      description: 'Response HTTP status code (always 200)',
    },
    data: {
      description: 'Response body',
      oneOf: [
        {
          type: 'object',
          example: {
            strProp: 'a-string',
            intProp: 100,
          },
          additionalProperties: true,
        },
        {
          type: 'array',
          items: {},
          example: [
            {
              strProp: 'a-string',
              intProp: 100,
            },
          ],
        },
      ],
    },
  },
  required: ['status', 'data'],
};

export const BatchResponseItemErrorComponent = {
  type: 'object',
  properties: {
    status: {
      type: 'integer',
      example: 400,
      description: 'Response HTTP status code (different than 200)',
    },
    errors: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          message: {
            type: 'string',
            description: 'Error message',
          },
        },
        required: ['message'],
        additionalProperties: true,
      },
      minItems: 1,
      maxItems: 1,
      example: [
        {
          message: 'Invalid parameters',
        },
      ],
    },
  },
  required: ['status', 'errors'],
};
