#!/usr/bin/env node

/**
 * Script: copy_code_with_dependencies_to_clipboard.mjs
 * Description:
 *   Recursively copies the content of a specified entry file and all its
 *   imported application files (TS, JS, TSX, JSX) to the clipboard,
 *   respecting a specified token limit. The script resolves relative imports
 *   and avoids including the same file multiple times.
 *
 * Usage:
 *   copy_code_with_dependencies_to_clipboard.mjs [entry_file] --token-limit [limit]
 *
 * Example:
 *   copy_code_with_dependencies_to_clipboard.mjs src/App.tsx --token-limit 2000
 */

import fs from 'fs';
import path from 'path';
import clipboardy from 'clipboardy';
import { parse } from '@babel/parser';
import { fileURLToPath } from 'url';

// Convert __dirname and __filename for ESM
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define supported file extensions
const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

// Initialize variables
let entryFile = '';
let tokenLimit = 16000;

// Parse command-line arguments
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--token-limit') {
    if (i + 1 < args.length && /^\d+$/.test(args[i + 1])) {
      tokenLimit = parseInt(args[i + 1], 10);
      i++;
    } else {
      console.error('❌ Invalid token limit provided.');
      process.exit(1);
    }
  } else {
    if (!entryFile) {
      entryFile = args[i];
    } else {
      console.error(`❌ Unexpected argument: ${args[i]}`);
      console.error('Usage: copy_code_with_dependencies_to_clipboard.mjs [entry_file] --token-limit [limit]');
      process.exit(1);
    }
  }
}

if (!entryFile) {
  console.error('❌ No entry file specified.');
  console.error('Usage: copy_code_with_dependencies_to_clipboard.mjs [entry_file] --token-limit [limit]');
  process.exit(1);
}

// Convert entryFile to absolute path
const absoluteEntryFile = path.resolve(process.cwd(), entryFile);

// Check if entry file exists
if (!fs.existsSync(absoluteEntryFile)) {
  console.error(`❌ Entry file '${absoluteEntryFile}' does not exist.`);
  process.exit(1);
}

// Function to estimate tokens (1 token ≈ 4 characters)
const estimateTokens = (text) => Math.ceil(text.length / 4);

// Function to parse imports using @babel/parser
const parseImports = (fileContent, filePath) => {
  let imports = [];
  try {
    const ast = parse(fileContent, {
      sourceType: 'unambiguous',
      plugins: [
        'typescript',
        'jsx',
        'classProperties',
        'dynamicImport',
        // Add other plugins if your code uses more advanced syntax
      ],
    });

    const traverse = (node) => {
      if (!node) return;
      switch (node.type) {
        case 'ImportDeclaration':
          if (
            node.source &&
            node.source.value &&
            (node.source.value.startsWith('./') || node.source.value.startsWith('../'))
          ) {
            imports.push(node.source.value);
          }
          break;
        case 'CallExpression':
          if (node.callee.name === 'require' && node.arguments.length === 1) {
            const arg = node.arguments[0];
            if (
              arg.type === 'StringLiteral' &&
              (arg.value.startsWith('./') || arg.value.startsWith('../'))
            ) {
              imports.push(arg.value);
            }
          }
          break;
        default:
          break;
      }

      // Recursively traverse child nodes
      for (const key in node) {
        if (node.hasOwnProperty(key)) {
          const child = node[key];
          if (Array.isArray(child)) {
            child.forEach((c) => {
              if (typeof c.type === 'string') traverse(c);
            });
          } else if (child && typeof child.type === 'string') {
            traverse(child);
          }
        }
      }
    };

    traverse(ast);
  } catch (error) {
    console.error(`⚠️  Failed to parse ${filePath}: ${error.message}`);
  }

  return imports;
};

// Function to resolve import paths to actual files
const resolveImportPath = (importPath, baseDir) => {
  // Handle relative imports only
  if (!(importPath.startsWith('./') || importPath.startsWith('../'))) {
    return null; // Non-relative imports are ignored
  }

  // Resolve the absolute path without extension
  const potentialPaths = EXTENSIONS.map((ext) => path.resolve(baseDir, `${importPath}${ext}`));

  // Also consider index files in directories
  const importDir = path.resolve(baseDir, importPath);
  const indexPaths = EXTENSIONS.map((ext) => path.resolve(importDir, `index${ext}`));

  const allPotentialPaths = [...potentialPaths, ...indexPaths];

  for (const p of allPotentialPaths) {
    if (fs.existsSync(p) && fs.statSync(p).isFile()) {
      return p;
    }
  }

  return null; // File not found
};

// Initialize processing queues and trackers
const processedFiles = new Set();
const fileQueue = [absoluteEntryFile];
let aggregatedOutput = '';
let summary = '\nSummary of included files:\n';
let currentTokens = 0;
let includedCount = 0;
let skippedCount = 0;
let limitReached = false; // Flag to track when the token limit is exceeded

// Main processing loop
while (fileQueue.length > 0) {
  const currentFile = fileQueue.shift();

  if (processedFiles.has(currentFile)) continue; // Skip if already processed

  processedFiles.add(currentFile);

  const ext = path.extname(currentFile);
  if (!EXTENSIONS.includes(ext)) continue; // Skip unsupported file types

  let content;
  try {
    content = fs.readFileSync(currentFile, 'utf-8');
  } catch (error) {
    skippedCount++;
    continue;
  }

  const tokens = estimateTokens(content);

  if (currentTokens + tokens > tokenLimit) {
    // Only skip files if adding them would exceed the token limit
    if (currentTokens >= tokenLimit) {
      skippedCount++;
      continue;
    }
  }

  // Convert absolute paths to relative paths for output
  const relativeFilePath = path.relative(process.cwd(), currentFile);

  // Append content to output
  aggregatedOutput += `### File: ${relativeFilePath}\n---\n\`\`\`${ext.slice(1)}\n${content}\n\`\`\`\n\n`;
  summary += `${relativeFilePath}\n`;
  currentTokens += tokens;
  includedCount++;

  // Parse imports and enqueue them
  const imports = parseImports(content, currentFile);
  const baseDir = path.dirname(currentFile);

  for (const importPath of imports) {
    const resolvedPath = resolveImportPath(importPath, baseDir);
    if (resolvedPath && !processedFiles.has(resolvedPath) && !fileQueue.includes(resolvedPath)) {
      fileQueue.push(resolvedPath);
    }
  }

  // Check if token limit is exceeded after processing the file
  if (currentTokens >= tokenLimit) {
    limitReached = true;
  }
}

// Copy to clipboard
clipboardy.write(aggregatedOutput)
  .then(() => {
    console.log(`✅ Copied up to ${tokenLimit} tokens to clipboard.`);
    console.log(`Included files (${includedCount}):`);
    console.log(summary);
    console.log(`Skipped files: ${skippedCount}.`);
  })
  .catch((error) => {
    console.error(`❌ Failed to copy to clipboard: ${error.message}`);
    process.exit(1);
  });
