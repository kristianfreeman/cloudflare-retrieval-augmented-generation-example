import { WorkflowEntrypoint, WorkflowEvent, WorkflowStep } from 'cloudflare:workers'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { methodOverride } from 'hono/method-override'

// @ts-expect-error
import notes from './notes.html'
// @ts-expect-error
import ui from './ui.html'
// @ts-expect-error
import write from './write.html'

type Env = {
  AI: Ai;
  DATABASE: D1Database;
  RAG_WORKFLOW: Workflow;
  VECTOR_INDEX: VectorizeIndex
};

type Note = {
  id: string;
  text: string;
}

type Params = {
  text: string;
};

const app = new Hono<{ Bindings: Env }>()
app.use(cors())

app.get('/notes.json', async (c) => {
  const query = `SELECT * FROM notes`
  const { results } = await c.env.DATABASE.prepare(query).all()
  return c.json(results);
})

app.get('/notes', async (c) => {
  return c.html(notes);
})

app.use('/notes/:id', methodOverride({ app }))
app.delete('/notes/:id', async (c) => {
  const { id } = c.req.param();
  const query = `DELETE FROM notes WHERE id = ?`
  await c.env.DATABASE.prepare(query).bind(id).run()
  await c.env.VECTOR_INDEX.deleteByIds([id])
  return c.redirect('/notes')
})

app.post('/notes', async (c) => {
  const { text } = await c.req.json();
  if (!text) return c.text("Missing text", 400);
  await c.env.RAG_WORKFLOW.create({ params: { text } })
  return c.text("Created note", 201);
})

app.get('/ui', async (c) => {
  return c.html(ui);
})

app.get('/write', async (c) => {
  return c.html(write);
})

app.get('/', async (c) => {
  const question = c.req.query('text') || "What is the square root of 9?"

  const embeddings = await c.env.AI.run('@cf/baai/bge-base-en-v1.5', { text: question })
  const vectors = embeddings.data[0]

  const vectorQuery = await c.env.VECTOR_INDEX.query(vectors, { topK: 1 });
  const vecId = vectorQuery.matches[0]?.id

  let notes: string[] = []
  if (vecId) {
    const query = `SELECT * FROM notes WHERE id = ?`
    const { results } = await c.env.DATABASE.prepare(query).bind(vecId).all<Note>()
    if (results) notes = results.map(note => note.text)
  }

  const contextMessage = notes.length
    ? `Context:\n${notes.map(note => `- ${note}`).join("\n")}`
    : ""

  const systemPrompt = `When answering the question or responding, use the context provided, if it is provided and relevant.`

  const response = await c.env.AI.run(
    "@cf/meta/llama-3.1-8b-instruct",
    {
      messages: [
        ...(notes.length ? [{ role: 'system', content: contextMessage }] : []),
        { role: 'system', content: systemPrompt },
        { role: 'user', content: question }
      ] as RoleScopedChatInput[]
    }
  ) as AiTextGenerationOutput

  return response ? c.text((response as any).response) : c.text("We were unable to generate output", 500)
})

export class RAGWorkflow extends WorkflowEntrypoint<Env, Params> {
  async run(event: WorkflowEvent<Params>, step: WorkflowStep) {
    const env = this.env
    const { text } = event.payload;

    const record = await step.do('create database record', async () => {
      const query = "INSERT INTO notes (text) VALUES (?) RETURNING *"

      const { results } = await env.DATABASE.prepare(query)
        .bind(text)
        .run<Note>()

      const record = results[0]
      if (!record) throw new Error("Failed to create note")
      return record;
    })

    const embedding = await step.do('generate embedding', async () => {
      const embeddings = await env.AI.run('@cf/baai/bge-base-en-v1.5', { text: text })
      const values = embeddings.data[0]
      if (!values) throw new Error("Failed to generate vector embedding")
      return values
    })

    await step.do('insert vector', async () => {
      return env.VECTOR_INDEX.upsert([
        {
          id: record.id.toString(),
          values: embedding,
        }
      ]);
    })
  }
}

export default app
