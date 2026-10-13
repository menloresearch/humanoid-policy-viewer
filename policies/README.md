# policies/

Drop your own policies here and `npm run dev` lists them in the policy dropdown.
Nothing in this folder is committed or built into `dist/`, except this file.

One folder per policy:

```
policies/
└── my-policy/
    ├── policy.onnx
    ├── env.yaml        required: the training run's gains, action scale, torque limits
    └── agent.yaml      recommended: records the training run
```

`env.yaml` may also sit under `params/`. See `docs/policy-config.md` for what the
viewer reads from it, and `docs/policy-library.md` to serve policies from
somewhere else.
