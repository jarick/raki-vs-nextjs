import { NodeSDK } from '@opentelemetry/sdk-node'
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http'

export function register() {
  const sdk = new NodeSDK({
    traceExporter: new OTLPTraceExporter(),
  })
  sdk.start()
}
