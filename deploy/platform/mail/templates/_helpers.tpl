{{- define "mail.name" -}}
{{- .Release.Name | trunc 50 | trimSuffix "-" -}}
{{- end -}}

{{- define "mail.labels" -}}
app.kubernetes.io/name: stalwart
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version }}
{{- end -}}

{{- define "mail.selectorLabels" -}}
app.kubernetes.io/name: stalwart
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "mail.emailDomain" -}}
{{- .Values.emailDomain | default (required "domain is required" .Values.domain) -}}
{{- end -}}

{{- define "mail.hostname" -}}
{{- .Values.hostname | default (printf "mail.%s" (include "mail.emailDomain" .)) -}}
{{- end -}}

{{/*
The mail listeners: the port each has on the Service (what DNS, senders and the
application use) and the one the server listens on in its container. Unprivileged
container ports, so the server needs no capability to bind them; the Service maps one
to the other.
*/}}
{{- define "mail.listeners" -}}
smtp: { port: 25, containerPort: 2525, protocol: smtp, tlsImplicit: false }
submissions: { port: 465, containerPort: 4650, protocol: smtp, tlsImplicit: true }
submission: { port: 587, containerPort: 5870, protocol: smtp, tlsImplicit: false }
imaps: { port: 993, containerPort: 9930, protocol: imap, tlsImplicit: true }
{{- end -}}

{{/*
The settings, as stalwart-cli apply operations (NDJSON, one per line; lists are objects
keyed "0", "1", …; "#domain" is the domain of an earlier line): logs to stdout, the
listeners (exactly these: the server's defaults on 443, 995 and 4190 go), the
domain with our own DKIM key and certificate, the host name, the account the
application submits as, and the delivery-failure webhook. Upserts match on a natural
key, so applying them again changes nothing that didn't change. Secrets are
read from files and the environment by the server itself, except the submission
password, which the plan init container writes in for @SMTP_PASSWORD@.
*/}}
{{- define "mail.plan" -}}
{{- $domain := include "mail.emailDomain" . -}}
{{- $listeners := dict "http" (dict "name" "http" "protocol" "http" "bind" (dict "[::]:8080" true) "tlsImplicit" false) -}}
{{- range $name, $l := include "mail.listeners" . | fromYaml -}}
{{- $_ := set $listeners $name (dict "name" $name "protocol" $l.protocol "bind" (dict (printf "[::]:%v" $l.containerPort) true) "tlsImplicit" $l.tlsImplicit) -}}
{{- end -}}
{{- $ops := list
  (dict "@type" "reconcile" "object" "Tracer" "matchOn" "*" "value" (dict "console" (dict
    "@type" "Stdout" "level" "info" "enable" true "ansi" false "buffered" false
    "multiline" false "lossy" false "events" dict "eventsPolicy" "exclude")))
  (dict "@type" "reconcile" "object" "NetworkListener" "matchOn" (list "name") "value" $listeners)
  (dict "@type" "upsert" "object" "Domain" "matchOn" (list "name") "value" (dict "domain" (dict
    "name" $domain
    "certificateManagement" (dict "@type" "Manual")
    "dkimManagement" (dict "@type" "Manual")
    "dnsManagement" (dict "@type" "Manual")
    "subAddressing" (dict "@type" "Enabled"))))
  (dict "@type" "upsert" "object" "Certificate" "matchOn" (list "certificate") "value" (dict "certificate" (dict
    "certificate" (dict "@type" "File" "filePath" "/etc/stalwart/tls/tls.crt")
    "privateKey" (dict "@type" "File" "filePath" "/etc/stalwart/tls/tls.key"))))
  (dict "@type" "update" "object" "SystemSettings" "value" (dict
    "defaultHostname" (include "mail.hostname" .)
    "defaultDomainId" "#domain"
    "defaultCertificateId" "#certificate"))
  (dict "@type" "upsert" "object" "DkimSignature" "matchOn" (list "selector") "value" (dict "dkim" (dict
    "@type" "Dkim1RsaSha256"
    "domainId" "#domain"
    "selector" .Values.dkim.selector
    "privateKey" (dict "@type" "File" "filePath" "/etc/stalwart/dkim/private.key"))))
  (dict "@type" "upsert" "object" "Account" "matchOn" (list "name" "domainId") "value" (dict "sender" (dict
    "@type" "User"
    "name" .Values.submission.account
    "domainId" "#domain"
    "credentials" (dict "0" (dict "@type" "Password" "secret" "@SMTP_PASSWORD@")))))
-}}
{{- if .Values.webhook.enabled -}}
{{- $events := dict -}}
{{- range .Values.webhook.events }}{{ $_ := set $events . true }}{{ end -}}
{{- $ops = append $ops (dict "@type" "upsert" "object" "WebHook" "matchOn" (list "url") "value" (dict "webhook" (dict
    "url" (required "webhook.url is required with the webhook on" .Values.webhook.url)
    "signatureKey" (dict "@type" "EnvironmentVariable" "variableName" "STALWART_WEBHOOK_SECRET")
    "httpAuth" (dict "@type" "Unauthenticated")
    "httpHeaders" dict
    "events" $events
    "eventsPolicy" "include"))) -}}
{{- end -}}
{{- with .Values.relay.host -}}
{{- $r := $.Values.relay -}}
{{- $ops = append $ops (dict "@type" "upsert" "object" "MtaRoute" "matchOn" (list "name") "value" (dict "relay" (dict
    "@type" "Relay"
    "name" "relay"
    "address" .
    "port" $r.port
    "protocol" "smtp"
    "implicitTls" $r.implicitTls
    "allowInvalidCerts" false
    "authUsername" $r.username
    "authSecret" (ternary (dict "@type" "EnvironmentVariable" "variableName" "RELAY_PASSWORD") (dict "@type" "None") (ne $r.username ""))))) -}}
{{- /* Mail for our own domain stays local; everything else goes through the relay. */ -}}
{{- $ops = append $ops (dict "@type" "update" "object" "MtaOutboundStrategy" "value" (dict "route" (dict
    "match" (list (dict "if" "is_local_domain(rcpt_domain)" "then" "'local'"))
    "else" "'relay'"))) -}}
{{- end -}}
{{- range $i, $op := concat $ops .Values.extraPlan -}}
{{- if $i }}{{ "\n" }}{{ end }}{{ toJson $op }}
{{- end -}}
{{- end -}}

{{/* What the server reads and writes, in recovery mode and normally alike. */}}
{{- define "mail.serverMounts" -}}
- { name: config, mountPath: /etc/stalwart/config.json, subPath: config.json, readOnly: true }
- { name: data, mountPath: /var/lib/stalwart }
- { name: tls, mountPath: /etc/stalwart/tls, readOnly: true }
- { name: dkim, mountPath: /etc/stalwart/dkim, readOnly: true }
- { name: provision, mountPath: /run/provision }
- { name: tmp, mountPath: /tmp }
{{- end -}}
