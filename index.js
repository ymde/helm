const core = require("@actions/core");
const github = require("@actions/github");
const exec = require("@actions/exec");
const fs = require("fs");
const util = require("util");
const Mustache = require("mustache");

const writeFile = util.promisify(fs.writeFile);
const readFile = util.promisify(fs.readFile);
const required = { required: true };

/**
 * Status marks the deployment status. Only activates if token is set as an
 * input to the job.
 *
 * @param {string} state
 */
async function status(state) {
  try {
    const context = github.context;
    const deployment = context.payload.deployment;
    const token = core.getInput("token");
    if (!token || !deployment) {
      core.debug("not setting deployment status");
      return;
    }

    const client = new github.GitHub(token);
    const url = `https://github.com/${context.repo.owner}/${context.repo.repo}/commit/${context.sha}/checks`;

    await client.repos.createDeploymentStatus({
      ...context.repo,
      deployment_id: deployment.id,
      state,
      log_url: url,
      target_url: url,
      headers: {
        accept: 'application/vnd.github.ant-man-preview+json'
      }
    });
  } catch (error) {
    core.warning(`Failed to set deployment status: ${error.message}`);
  }
}

function releaseName(name, track) {
  if (track !== "stable") {
    return `${name}-${track}`;
  }
  return name;
}

function chartName(name) {
  if (name === "app") {
    return "/usr/src/charts/app";
  }
  return name;
}

function getValues(values) {
  if (!values) {
    return "{}";
  }
  if (typeof values === "object") {
    return JSON.stringify(values);
  }
  return values;
}

function getSecrets(secrets) {
  if (typeof secrets === "string") {
    try {
      return JSON.parse(secrets);
    } catch (err) {
      return secrets;
    }
  }
  return secrets;
}

function getValueFiles(files) {
  let fileList;
  if (typeof files === "string") {
    try {
      fileList = JSON.parse(files);
    } catch (err) {
      // Assume it's a single string.
      fileList = [files];
    }
  } else {
    fileList = files;
  }
  if (!Array.isArray(fileList)) {
    return [];
  }
  return fileList.filter(f => !!f);
}

function getInput(name, options) {
  const context = github.context;
  const deployment = context.payload.deployment;
  let val = core.getInput(name.replace("_", "-"), {
    ...options,
    required: false
  });
  if (deployment) {
    if (deployment[name]) val = deployment[name];
    if (deployment.payload[name]) val = deployment.payload[name];
  }
  if (options && options.required && !val) {
    throw new Error(`Input required and not supplied: ${name}`);
  }
  return val;
}

/**
 * Render files renders data into the list of provided files.
 * @param {Array<string>} files
 * @param {any} data
 */
function renderFiles(files, data) {
  core.debug(
    `rendering value files [${files.join(",")}] with: ${JSON.stringify(data)}`
  );
  const tags = ["${{", "}}"];
  const promises = files.map(async file => {
    const content = await readFile(file, { encoding: "utf8" });
    const rendered = Mustache.render(content, data, {}, tags);
    await writeFile(file, rendered);
  });
  return Promise.all(promises);
}

/**
 * Makes a delete command for compatibility between helm 2 and 3.
 *
 * @param {string} helm
 * @param {string} namespace
 * @param {string} release
 */
function deleteCmd(helm, namespace, release) {
  if (helm === "helm3") {
    return ["delete", "-n", namespace, release];
  }
  return ["delete", "--purge", release];
}

/*
 * Optionally add a helm repository
 */
async function addRepo(helm) {
  const repo = getInput("repo");
  const repoAlias = getInput("repo-alias");
  const repoUsername = getInput("repo-username");
  const repoPassword = getInput("repo-password");

  core.debug(`param: repo = "${repo}"`);
  core.debug(`param: repoAlias = "${repoAlias}"`);
  core.debug(`param: repoUsername = "${repoUsername}"`);
  core.debug(`param: repoPassword = "${repoPassword}"`);

  if (repo !== "") {
    if (repoAlias === "") {
      throw new Error("repo alias is required when you are setting a repository");
    }

    core.debug(`adding custom repository ${repo} with alias ${repoAlias}`);

    const args = [
      "repo",
      "add",
      repoAlias,
      repo,
    ]

    if (repoUsername) args.push(`--username=${repoUsername}`);
    if (repoPassword) args.push(`--password=${repoPassword}`);

    await exec.exec(helm, args);
    await exec.exec(helm, ["repo", "update"])
  }

  return Promise.resolve()
}

/*
 * Optionally add a helm repository
 */
async function registryLogin(helm) {
  const repo = getInput("oci-repo");
  const repoUsername = getInput("oci-repo-username");
  const repoPassword = getInput("oci-repo-password");

  core.debug(`param: oci-repo = "${repo}"`);
  core.debug(`param: ociRepoUsername = "${repoUsername}"`);
  core.debug(`param: ociRepoPassword = "${repoPassword}"`);

  if (repo !== "") {
    core.debug(`adding custom registry ${repo}`);

    const args = [
      "registry",
      "login",
      repo,
    ]

    if (repoUsername) args.push(`--username=${repoUsername}`);
    if (repoPassword) args.push(`--password=${repoPassword}`);
    
    await exec.exec(helm, args);
  }

  return Promise.resolve()
}

/*
 * Deploy the release
 */
async function deploy(helm) {
  const context = github.context;

  const track = getInput("track") || "stable";
  const appName = getInput("release", required);
  const release = releaseName(appName, track);
  const namespace = getInput("namespace", required);
  const chart = chartName(getInput("chart", required));
  const chartVersion = getInput("chart_version");
  const values = getValues(getInput("values"));
  const task = getInput("task");
  const version = getInput("version");
  const valueFiles = getValueFiles(getInput("value_files"));
  const removeCanary = getInput("remove_canary");
  const timeout = getInput("timeout");
  const dryRun = core.getInput("dry-run");
  const secrets = getSecrets(core.getInput("secrets"));
  const atomic = getInput("atomic") || true;

  core.debug(`param: track = "${track}"`);
  core.debug(`param: release = "${release}"`);
  core.debug(`param: appName = "${appName}"`);
  core.debug(`param: namespace = "${namespace}"`);
  core.debug(`param: chart = "${chart}"`);
  core.debug(`param: chart_version = "${chartVersion}"`);
  core.debug(`param: values = "${values}"`);
  core.debug(`param: dryRun = "${dryRun}"`);
  core.debug(`param: task = "${task}"`);
  core.debug(`param: version = "${version}"`);
  core.debug(`param: secrets = "${JSON.stringify(secrets)}"`);
  core.debug(`param: valueFiles = "${JSON.stringify(valueFiles)}"`);
  core.debug(`param: removeCanary = ${removeCanary}`);
  core.debug(`param: timeout = "${timeout}"`);
  core.debug(`param: atomic = "${atomic}"`);

  // Setup command options and arguments.
  let args = [
    "upgrade",
    release,
    chart,
    "--install",
    "--wait",
    `--namespace=${namespace}`,
  ];

  if (dryRun) args.push("--dry-run");
  if (appName) args.push(`--set=app.name=${appName}`);
  if (version) args.push(`--set=app.version=${version}`);
  if (chartVersion) args.push(`--version=${chartVersion}`);
  if (timeout) args.push(`--timeout=${timeout}`);

  valueFiles.forEach(f => args.push(`--values=${f}`));

  args.push("--values=./values.yml");

  // Special behaviour is triggered if the track is labelled 'canary'. The
  // service and ingress resources are disabled. Access to the canary
  // deployments can be routed via the main stable service resource.
  if (track === "canary") {
    args.push("--set=service.enabled=false", "--set=ingress.enabled=false");
  }

  // If true upgrade process rolls back changes made in case of failed upgrade.
  if (atomic === true) {
    args.push("--atomic");
  }

  await writeFile("./values.yml", values);

  core.debug(`env: KUBECONFIG="${process.env.KUBECONFIG}"`);

  // Render value files using github variables.
  await renderFiles(valueFiles.concat(["./values.yml"]), {
    secrets,
    deployment: context.payload.deployment,
  });

  // Remove the canary deployment before continuing.
  if (removeCanary) {
    core.debug(`removing canary ${appName}-canary`);
    await exec.exec(helm, deleteCmd(helm, namespace, `${appName}-canary`), {
      ignoreReturnCode: true
    });
  }

  // Actually execute the deployment here.
  if (task === "remove") {
    return exec.exec(helm, deleteCmd(helm, namespace, release), {
      ignoreReturnCode: true
    });
  }

  return exec.exec(helm, args);
}

/**
 * Run executes the helm deployment.
 */
async function run() {
  const commands = [addRepo, registryLogin, deploy]

  try {
    await status("pending");

    process.env.XDG_DATA_HOME = "/root/.helm/"
    process.env.XDG_CACHE_HOME = "/root/.helm/"
    process.env.XDG_CONFIG_HOME = "/root/.helm/"
  
    // Setup necessary files.
    if (process.env.KUBECONFIG_FILE) {
      process.env.KUBECONFIG = "./kubeconfig.yml";
      await writeFile(process.env.KUBECONFIG, process.env.KUBECONFIG_FILE);
    }
    
    const helm = getInput("helm") || "helm3";
    core.debug(`param: helm = "${helm}"`);

    for(const command of commands) {
      core.debug(`executing ${command.name}`);
      await command(helm);
    }

    await status("success");
  } catch (error) {
    core.error(error);
    core.setFailed(error.message);
    await status("failure");
  }
}

run();
