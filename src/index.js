import { promises as fs } from "fs"
import * as core from "@actions/core"
import * as github from "@actions/github"
import path from "path"

import { parse } from "./lcov"
import { diff } from "./comment"
import { getChangedFiles } from "./get_changes"
import { deleteOldComments } from "./delete_old_comments"
import { normalisePath } from "./util"

const MAX_COMMENT_CHARS = 65536

async function main() {
	const token = core.getInput("github-token")
	const githubClient = github.getOctokit(token)
	const workingDir = core.getInput("working-directory") || "./"
	const lcovFile = path.join(
		workingDir,
		core.getInput("lcov-file") || "./coverage/lcov.info",
	)
	const baseFile = core.getInput("lcov-base")
	const shouldFilterChangedFiles =
		core.getInput("filter-changed-files").toLowerCase() === "true"
	const shouldDeleteOldComments =
		core.getInput("delete-old-comments").toLowerCase() === "true"
	const title = core.getInput("title")

	const raw = await fs.readFile(lcovFile, "utf-8").catch((err) => null)
	if (!raw) {
		console.log(`No coverage report found at '${lcovFile}', exiting...`)
		return
	}

	const baseRaw =
		baseFile && (await fs.readFile(baseFile, "utf-8").catch((err) => null))
	if (baseFile && !baseRaw) {
		console.log(`No coverage report found at '${baseFile}', ignoring...`)
	}

	const options = {
		repository: github.context.payload.repository.full_name,
		prefix: normalisePath(`${process.env.GITHUB_WORKSPACE}/`),
		workingDir,
	}

	if (
		github.context.eventName === "pull_request" ||
		github.context.eventName === "pull_request_target"
	) {
		options.commit = github.context.payload.pull_request.head.sha
		options.baseCommit = github.context.payload.pull_request.base.sha
		options.head = github.context.payload.pull_request.head.ref
		options.base = github.context.payload.pull_request.base.ref
	} else if (github.context.eventName === "push") {
		options.commit = github.context.payload.after
		options.baseCommit = github.context.payload.before
		options.head = github.context.ref
	}

	options.shouldFilterChangedFiles = shouldFilterChangedFiles
	options.title = title

	if (shouldFilterChangedFiles) {
		options.changedFiles = await getChangedFiles(
			githubClient,
			options,
			github.context,
		)
	}

	const lcov = await parse(raw)
	const baselcov = baseRaw && (await parse(baseRaw))
	const body = diff(lcov, baselcov, options).substring(0, MAX_COMMENT_CHARS)

	if (shouldDeleteOldComments) {
		await deleteOldComments(githubClient, options, github.context)
	}

	if (
		github.context.eventName === "pull_request" ||
		github.context.eventName === "pull_request_target"
	) {
		await githubClient.issues.createComment({
			repo: github.context.repo.repo,
			owner: github.context.repo.owner,
			issue_number: github.context.payload.pull_request.number,
			body: body,
		})
	} else if (github.context.eventName === "push") {
		await githubClient.repos.createCommitComment({
			repo: github.context.repo.repo,
			owner: github.context.repo.owner,
			commit_sha: options.commit,
			body: body,
		})
	}
}

main().catch(function (err) {
	console.log(err)
	core.setFailed(err.message)
})
