mod util;

use util::{add, default_config, StringHelper};

fn main() {
    let config = default_config();
    let result = add(config.port as i32, 1);
    let helper = StringHelper::new("App");
    println!("{}", helper.format(&format!("running on port {}", result)));
}

fn process_items(items: &[String]) -> i32 {
    let mut total = 0;
    for item in items {
        total = add(total, item.len() as i32);
    }
    total
}
