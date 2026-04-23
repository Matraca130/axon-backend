#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if ! command -v ruby >/dev/null 2>&1; then
  echo "ERROR: ruby is required to parse workflow YAML files." >&2
  exit 2
fi

echo "Checking workflow YAML syntax and local script references..."

ruby <<'RUBY'
require 'yaml'

workflow_files = Dir.glob('.github/workflows/*.{yml,yaml}').sort
if workflow_files.empty?
  warn 'ERROR: no workflow files found under .github/workflows/'
  exit 1
end

failed = false
script_refs = []

workflow_files.each do |path|
  begin
    content = File.read(path)
    YAML.safe_load(content, permitted_classes: [], aliases: true)
    puts "  OK  #{path} (valid YAML)"

    content.scan(/(?:\bbash\b|\bsh\b)\s+([A-Za-z0-9_\.\/\-]+\.sh)/).flatten.each do |ref|
      script_refs << ref
    end
  rescue => e
    failed = true
    warn "  ERR #{path}: #{e.class}: #{e.message}"
  end
end

script_refs.uniq.sort.each do |ref|
  if File.file?(ref)
    puts "  OK  #{ref} (referenced script exists)"
  else
    failed = true
    warn "  ERR #{ref} (referenced by workflow but not found)"
  end
end

if failed
  warn "Workflow health checks failed."
  exit 1
else
  puts "Workflow health checks passed."
end
RUBY
