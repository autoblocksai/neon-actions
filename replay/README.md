# Autoblocks Replay Action

This is a GitHub Action that replays Autoblocks events through your LLM application and summarizes the results in a comment on the pull request.

## Example Usage

```yaml
- uses: autoblocksai/actions/replay@v1
  with:
    replay-method: POST
    replay-url: http://localhost:3000
    replay-view-id: clkeamsei0001l908cmjjtqrf
    replay-num-traces: 3
    replay-transform-config: |
      filters:
        message: request.payload
      mappers:
        query: properties.payload.query
    property-filter-config: |
      ai.intermediate.response:
        - response.id
        - response.created
    autoblocks-api-key: ${{ secrets.AUTOBLOCKS_API_KEY }}
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

## Inputs

### `replay-method`

**Required** The HTTP method to use when replaying events.

### `replay-url`

**Required** The URL to send replay requests to.

### `replay-view-id`

**Required** The ID of the Autoblocks view containing the events you want to replay.

### `replay-num-traces`

**Required** The number of traces from the above view to replay.

### `replay-transform-config`

**Optional** A YAML string that specifies how to filter and transform events before replaying them.

#### `replay-transform-config.filters`

The `filters` field is used to specify which events among the trace are replayable.
Most likely, this is the first event in the trace and contains the user input that triggered the trace.
For example, if the user's input is in an event where the message is `request.payload`, you'd use the filter:

```yaml
replay-transform-config:
  filters: |
    message: request.payload
```

If you want to filter on any properties in the event, you can add additional filters:

```yaml
replay-transform-config:
  filters: |
    message: request.payload
    properties.myprop: someValue
```

> **_NOTE:_** If no `filters` are specified, we replay all of the events in the trace. If your Autoblocks view is already configured to only include the events you want to replay, you can omit the `filters` field.

The format of the `filters` field is a map where the keys are fields on the `event` object and the values are the values you expect those fields to have.
Under the hood, we use Lodash's [`_.get`](https://lodash.com/docs/4.17.15#get) function to access the value on the event.
This means you can use the same syntax as `_.get` to specify nested fields:

```yaml
replay-transform-config:
  filters: |
    message: request.payload
    properties.some.nested.thing.with.arrays[0]: someValue
```

If it's helpful, here is pseudocode for how we use the filters to determine if an event is replayable:

```ts
interface TraceEvent {
  id: string;
  traceId: string;
  message: string;
  timestamp: string;
  properties: Record<string, unknown>;
}

const isReplayable = (event: TraceEvent): boolean =>
  replayTransformConfig.filters.every(
    (filter) => _.get(event, filter.key) === filter.value,
  );
```

#### `replay-transform-config.mappers`

The `mappers` field is useful for cases where the events you want to replay are not in the format expected by your LLM application.
For example, if your LLM application expects a query in the `query` field of the request body, but the events you want to replay have the query in the `properties.payload.query` field, you can use the following config to transform the events before replaying them:

```yaml
mappers:
  query: properties.payload.query
```

> **_NOTE:_** If no `mappers` are specified, we send all of the event's properties as the request body.

The format of the `mappers` field is a map where the keys are the fields you want to send in your replay request and the values are the fields on the event object that you want to use as the value for the key.
Under the hood, we use Lodash's [`_.get`](https://lodash.com/docs/4.17.15#get) function to get the value of the field on the event, so you can use the same syntax as `_.get` to specify nested fields:

```yaml
mappers:
  query: properties.payload.query
  someOtherField: properties.some.nested.thing.with.arrays[0]
```

If it's helpful, here is pseudocode for how we use the mappers to build the payload we send to your replay endpoint:

```ts
const makeReplayPayload = (event: TraceEvent): Record<string, unknown> => {
  if (replayTransformConfig.mappers.length === 0) {
    // Replay the event's properties as-is if there are no mappers
    return event.properties;
  }

  // Otherwise, use the mappers to build the replay payload
  const payload: Record<string, unknown> = {};
  for (const mapper of replayTransformConfig.mappers) {
    payload[mapper.key] = _.get(event, mapper.value);
  }
  return payload;
};
```

### `property-filter-config`

**Optional** A YAML string that specifies how to filter out properties from the events before summarizing them in the pull request comment.

This option is useful if your events have properties that:

- always change (e.g. timestamps, autogenerated IDs)
- sensitive information (e.g. personal user information, API keys)

The format of this YAML string is a map where the key is an event's message and the value is a list of property names to omit when summarizing the event.
For example, this config will filter out the `response.id` and `response.created` properties from events with the message `ai.intermediate.response`:

```yaml
property-filter-config:
  ai.intermediate.response:
    - response.id
    - response.created
```

Under the hood, we use Lodash's [`_.omit`](https://lodash.com/docs/4.17.15#omit) function to filter out the properties, so you can use the same syntax as `_.omit` to specify the path to the property you want to omit:

```ts
const filterEventProperties = (event: TraceEvent): Record<string, unknown> => {
  const filters = propertyFilterConfig[event.message] || [];
  return _.omit(event.properties, filters);
};
```