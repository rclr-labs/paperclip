{{- define "paperclip.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "paperclip.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "paperclip.selectorLabels" -}}
app.kubernetes.io/name: {{ include "paperclip.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "paperclip.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" }}
{{ include "paperclip.selectorLabels" . }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
paperclip.dev/topology: {{ .Values.topology | quote }}
{{- with .Values.color }}
paperclip.dev/color: {{ . | quote }}
{{- end }}
{{- end -}}

{{- define "paperclip.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "paperclip.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{- define "paperclip.image" -}}
{{- if .Values.image.digest -}}
{{- printf "%s@%s" .Values.image.repository .Values.image.digest -}}
{{- else -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) -}}
{{- end -}}
{{- end -}}

{{- define "paperclip.envSecretName" -}}
{{- if .Values.envSecret.existingSecret -}}
{{- .Values.envSecret.existingSecret -}}
{{- else -}}
{{- printf "%s-env" (include "paperclip.fullname" .) -}}
{{- end -}}
{{- end -}}

{{- define "paperclip.hasEnvSecret" -}}
{{- if or .Values.envSecret.existingSecret .Values.envSecret.create .Values.externalSecret.enabled -}}true{{- end -}}
{{- end -}}

{{- define "paperclip.claimName" -}}
{{- if .Values.persistence.existingClaim -}}
{{- .Values.persistence.existingClaim -}}
{{- else -}}
{{- printf "%s-home" (include "paperclip.fullname" .) -}}
{{- end -}}
{{- end -}}

{{/*
Guards. Rendered from templates/guards.yaml so `helm template` and
`helm install` both refuse unsafe combinations.
*/}}
{{- define "paperclip.guards" -}}
{{- $r := int .Values.replicaCount -}}
{{- if lt $r 1 -}}
{{- fail "replicaCount must be >= 1" -}}
{{- end -}}
{{- if and (gt $r 1) (not .Values.fencing.enabled) -}}
{{- fail "replicaCount > 1 is blocked until multi-process fencing ships (doc/plans/2026-11-11-distributed-deployment-architectures.md §6): a second server reaps the first one's runs by PID. Keep replicaCount=1, or use T2 blue/green with one scheduler." -}}
{{- end -}}
{{- if and (gt $r 1) .Values.persistence.enabled (ne .Values.persistence.accessMode "ReadWriteMany") -}}
{{- fail "replicaCount > 1 needs persistence.accessMode=ReadWriteMany (PAPERCLIP_HOME is shared state)" -}}
{{- end -}}
{{- if and (eq .Values.topology "t3") .Values.persistence.enabled (ne .Values.persistence.accessMode "ReadWriteMany") -}}
{{- fail "topology t3 needs persistence.accessMode=ReadWriteMany" -}}
{{- end -}}
{{- if and (eq .Values.topology "t2") .Values.persistence.enabled (not .Values.persistence.existingClaim) -}}
{{- fail "topology t2 (green) must share the active release's PAPERCLIP_HOME: set persistence.existingClaim" -}}
{{- end -}}
{{- if and .Values.envSecret.create .Values.externalSecret.enabled -}}
{{- fail "envSecret.create and externalSecret.enabled are mutually exclusive" -}}
{{- end -}}
{{- if and .Values.envSecret.existingSecret (or .Values.envSecret.create .Values.externalSecret.enabled) -}}
{{- fail "envSecret.existingSecret cannot be combined with envSecret.create or externalSecret.enabled" -}}
{{- end -}}
{{- if and (eq .Values.storage.provider "s3") (not .Values.storage.s3.bucket) -}}
{{- fail "storage.provider=s3 needs storage.s3.bucket" -}}
{{- end -}}
{{- if and .Values.runLogs.s3.enabled (not .Values.runLogs.s3.bucket) -}}
{{- fail "runLogs.s3.enabled needs runLogs.s3.bucket" -}}
{{- end -}}
{{- if not (has .Values.execution.mode (list "" "kubernetes" "any")) -}}
{{- fail "execution.mode must be empty, kubernetes or any" -}}
{{- end -}}
{{- if not (has .Values.topology (list "t1" "t2" "t3")) -}}
{{- fail "topology must be t1, t2 or t3" -}}
{{- end -}}
{{- end -}}
